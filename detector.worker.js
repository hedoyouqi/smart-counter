/* SMART COUNTER v1.1 · offline segmentation and repeated-item similarity matching.
 * Placement/spacing is never assumed. Results are hypotheses requiring human review.
 * No external library, model, or uploaded images. */
'use strict';

self.onmessage = function(event) {
  const m = event.data;
  if (m.type !== 'analyze') return;
  try {
    const started = performance.now();
    const output = analyze(m);
    output.ms = Math.round(performance.now() - started);
    self.postMessage({type:'result', jobId:m.jobId, ...output});
  } catch (err) {
    self.postMessage({type:'error', jobId:m.jobId, message:String(err && err.message || err)});
  }
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function median(nums) { if (!nums.length) return 0; const a=nums.slice().sort((x,y)=>x-y); return a[a.length>>1]; }
function luminance(r,g,b) { return (r*77 + g*150 + b*29) >> 8; }
function otsu(hist, pixels) {
  let sum=0; for (let i=0;i<256;i++) sum+=i*hist[i];
  let lowSum=0, low=0, best=0, bestScore=-1;
  for (let t=0;t<255;t++) {
    low+=hist[t]; if(!low || low===pixels) continue;
    lowSum+=t*hist[t];
    const score=(sum*low - lowSum*pixels)**2/(low*(pixels-low));
    if(score>bestScore) { bestScore=score;best=t; }
  }
  return best;
}
function colorDistance(a,b) {
  if(!a || !b) return 0;
  return Math.sqrt(.30*(a[0]-b[0])**2+.59*(a[1]-b[1])**2+.11*(a[2]-b[2])**2);
}
function similar(a,b,tolerance=60) {
  // Rotation-invariant: compare the distribution of foreground pixels, not position/order.
  if(!a || !b || a.area<=0 || b.area<=0) return false;
  const sizeDelta=Math.abs(Math.log(a.area/b.area));
  const shapeDelta=Math.abs(Math.log(Math.max(1,a.aspect||1)/Math.max(1,b.aspect||1)));
  const colorDelta=colorDistance(a.color,b.color);
  const sizeLimit=.35+clamp(tolerance,0,100)*.009;
  const shapeLimit=.40+clamp(tolerance,0,100)*.009;
  const colorLimit=48+clamp(tolerance,0,100)*.9;
  if(sizeDelta>sizeLimit || shapeDelta>shapeLimit || colorDelta>colorLimit) return false;
  return .65*sizeDelta/sizeLimit + .9*shapeDelta/shapeLimit + .45*colorDelta/colorLimit <= 1.05;
}
function repeatFilter(candidates,settings,reference) {
  const requested=settings.repeatMode || 'auto';
  const tolerance=clamp(Number(settings.repeatTolerance ?? 60),0,100);
  if(requested==='all') return {items:candidates,filtered:0,groupMode:'all',uncertain:false};
  if(requested==='reference' && reference?.area>0){
    const items=candidates.filter(x=>similar(x,reference,tolerance));
    return {items,filtered:candidates.length-items.length,groupMode:'reference',uncertain:false};
  }
  if(candidates.length<3) return {items:candidates,filtered:0,groupMode:'all',uncertain:false};
  // Largest set of mutually similar objects. This does NOT use a grid or regular spacing.
  // When there is no clear majority, keep all rather than silently dropping detections.
  let best=[],bestScore=-Infinity;
  const stride=Math.max(1,Math.ceil(candidates.length/160));
  for(let i=0;i<candidates.length;i+=stride) {
    const seed=candidates[i];
    const match=candidates.filter(c=>similar(c,seed,Math.min(70,tolerance)));
    const areaMedian=median(match.map(x=>x.area));
    const score=match.length+(areaMedian>0?Math.min(1,Math.log1p(areaMedian)/15):0);
    if(score>bestScore){best=match;bestScore=score;}
  }
  if(best.length>=3 && best.length>=Math.max(3,Math.ceil(candidates.length*.58)) && best.length<candidates.length) {
    // Re-fit once using the median-mass member for robustness to unusual seeds.
    const medianArea=median(best.map(x=>x.area));
    const seed=best.slice().sort((a,b)=>Math.abs(a.area-medianArea)-Math.abs(b.area-medianArea))[0];
    const items=candidates.filter(c=>similar(c,seed,Math.min(70,tolerance)));
    return {items,filtered:candidates.length-items.length,groupMode:'auto',uncertain:false};
  }
  return {items:candidates,filtered:0,groupMode:'all',uncertain:requested==='auto'&&candidates.length>=4};
}
function analyze({width:w,height:h,rgba,settings={},roi=null,bgColor=null,reference=null}) {
  if(!w || !h || w*h>4200000) throw new Error('사진 크기가 너무 큽니다.');
  const data = new Uint8ClampedArray(rgba);
  const count = w*h;
  if(data.length!==count*4) throw new Error('이미지 크기가 일치하지 않습니다.');
  const sens=clamp(Number(settings.sensitivity) || 50,0,100);
  const minDiameter=clamp(Number(settings.minSize) || 10,2,80);
  const mode=settings.recognitionMode || 'background';
  const doSplit=Boolean(settings.splitObjects);
  const box=roi ? {x:clamp(Math.floor(roi.x*w),0,w-1), y:clamp(Math.floor(roi.y*h),0,h-1), right:clamp(Math.ceil((roi.x+roi.w)*w),1,w),bottom:clamp(Math.ceil((roi.y+roi.h)*h),1,h)} : {x:0,y:0,right:w,bottom:h};
  const gray=new Uint8Array(count);
  const histogram=new Uint32Array(256);
  let validCount=0;
  for(let y=0;y<h;y++) {
    for(let x=0;x<w;x++) {
      const p=y*w+x, q=p*4;
      const lum=luminance(data[q],data[q+1],data[q+2]);gray[p]=lum;
      if(x>=box.x&&x<box.right&&y>=box.y&&y<box.bottom){ histogram[lum]++;validCount++; }
    }
  }
  // Sample many small patches around the frame edges. Median protects against objects in one corner.
  const samples=[];
  const anchors=[[.025,.025],[.5,.025],[.975,.025],[.025,.5],[.975,.5],[.025,.975],[.5,.975],[.975,.975]];
  const sr=Math.max(2,Math.min(7,Math.round(Math.min(w,h)*.008)));
  for(const [ax,ay] of anchors) {
    let rs=[],gs=[],bs=[];
    const cx=Math.round(ax*(w-1)),cy=Math.round(ay*(h-1));
    for(let y=Math.max(0,cy-sr);y<=Math.min(h-1,cy+sr);y+=2) {
      for(let x=Math.max(0,cx-sr);x<=Math.min(w-1,cx+sr);x+=2) {
        const k=(y*w+x)*4;
        rs.push(data[k]);gs.push(data[k+1]);bs.push(data[k+2]);
      }
    }
    samples.push([median(rs),median(gs),median(bs)]);
  }
  const hasCustomBackground=Array.isArray(bgColor)&&bgColor.length===3;
  const background=hasCustomBackground ? bgColor : [median(samples.map(p=>p[0])),median(samples.map(p=>p[1])),median(samples.map(p=>p[2]))];
  const bgLum=luminance(...background);
  const diff=(r,g,b)=>Math.sqrt(.30*(r-background[0])**2+.59*(g-background[1])**2+.11*(b-background[2])**2);
  const noise=samples.map(p=>diff(...p));
  const noiseMedian=median(noise), noiseMax=Math.max(...noise);
  const offset=(sens-50)*.32;
  const threshold=clamp((hasCustomBackground?24:Math.max(17,noiseMedian*1.9+17,noiseMax*.75+11))-offset,7,150);
  const otsuThreshold=otsu(histogram,validCount);
  const darkLimit=clamp(Math.min(otsuThreshold+4,bgLum-12)+offset,1,255);
  const lightLimit=clamp(Math.max(otsuThreshold,bgLum+12)-offset,0,254);

  let mask=new Uint8Array(count);
  for(let y=box.y;y<box.bottom;y++) {
    for(let x=box.x;x<box.right;x++) {
      const i=y*w+x, j=i*4;
      let yes=false;
      if(mode==='dark') yes=gray[i]<darkLimit;
      else if(mode==='light') yes=gray[i]>lightLimit;
      else yes=diff(data[j],data[j+1],data[j+2])>threshold;
      if(yes) mask[i]=1;
    }
  }
  // 3x3 majority filter: remove isolated sensor noise while preserving small circular items.
  if(w>4&&h>4){
    const cleaned=new Uint8Array(count);
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) {
      const i=y*w+x;
      if(x<=box.x||x>=box.right-1||y<=box.y||y>=box.bottom-1) {cleaned[i]=mask[i];continue;}
      const n=mask[i-1-w]+mask[i-w]+mask[i+1-w]+mask[i-1]+mask[i]+mask[i+1]+mask[i-1+w]+mask[i+w]+mask[i+1+w];
      cleaned[i]=(n>=5?1:0);
    }
    mask=cleaned;
  }

  // 8-connected components with integer label image, per-region moments and bounds.
  const labels=new Int32Array(count), queue=new Int32Array(count), regions=[];
  const minArea=Math.max(5,Math.PI*(minDiameter*.5)**2*.60);
  const maxArea=validCount*.40;
  let rawRegions=0;
  for(let y=box.y;y<box.bottom;y++) for(let x=box.x;x<box.right;x++) {
    const start=y*w+x;
    if(!mask[start]||labels[start]) continue;
    const id=++rawRegions;
    if(rawRegions>30000) throw new Error('검출 후보가 너무 많습니다. 최소 크기를 높이거나 배경을 바꿔주세요.');
    let head=0,tail=1,area=0,sx=0,sy=0,sxx=0,syy=0,sxy=0,srSum=0,sgSum=0,sbSum=0,minX=x,maxX=x,minY=y,maxY=y;
    queue[0]=start;labels[start]=id;
    while(head<tail) {
      const p=queue[head++],px=p%w,py=(p/w)|0;
      area++;sx+=px;sy+=py;sxx+=px*px;syy+=py*py;sxy+=px*py;
      const ck=p*4;srSum+=data[ck];sgSum+=data[ck+1];sbSum+=data[ck+2];
      if(px<minX)minX=px;if(px>maxX)maxX=px;if(py<minY)minY=py;if(py>maxY)maxY=py;
      for(let oy=-1;oy<=1;oy++){
        const ny=py+oy;if(ny<box.y||ny>=box.bottom)continue;
        for(let ox=-1;ox<=1;ox++){
          if(!ox&&!oy)continue;
          const nx=px+ox;if(nx<box.x||nx>=box.right)continue;
          const q=ny*w+nx;
          if(mask[q]&&!labels[q]){labels[q]=id;queue[tail++]=q;}
        }
      }
    }
    if(area>=minArea && area<=maxArea){
      const bw=maxX-minX+1,bh=maxY-minY+1;
      // Ignore huge stripe-shaped regions that are probably shadows or surface edges.
      if((bw>validCount/(box.bottom-box.y)*.90 || bh>(box.bottom-box.y)*.90) && area>validCount*.08)continue;
      const mx=sx/area,my=sy/area;
      const vx=Math.max(0,sxx/area-mx*mx),vy=Math.max(0,syy/area-my*my),cxy=sxy/area-mx*my;
      const discriminant=Math.sqrt(Math.max(0,(vx-vy)*(vx-vy)+4*cxy*cxy));
      const larger=Math.max(0.3,(vx+vy+discriminant)/2),smaller=Math.max(0.3,(vx+vy-discriminant)/2);
      const aspect=Math.sqrt(larger/smaller);
      regions.push({id,area,x:mx,y:my,minX,maxX,minY,maxY,bw,bh,aspect,
        color:[Math.round(srSum/area),Math.round(sgSum/area),Math.round(sbSum/area)]});
    }
  }
  // If foreground detection captured nearly everything, do not report a false '1'.
  const accepted=regions.filter(r=>!(r.area>validCount*.2 && (r.bw>(box.right-box.x)*.75 ||r.bh>(box.bottom-box.y)*.75)));
  const items=[];
  let splitExtras=0, edgeCount=0, potentialTouching=0;
  const acceptedAreas=accepted.filter(r=>Math.max(r.bw,r.bh)/Math.max(1,Math.min(r.bw,r.bh))<1.5).map(r=>r.area);
  const typicalArea=median(acceptedAreas) || median(accepted.map(r=>r.area));
  let dist=null;
  if(doSplit && accepted.length) {
    // Approximate Euclidean distance transform, chamfer distances in tenths of a pixel.
    dist=new Uint16Array(count);
    for(let i=0;i<count;i++) dist[i]=mask[i]?30000:0;
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) {
      const i=y*w+x;if(!mask[i])continue;
      dist[i]=Math.min(dist[i],dist[i-1]+10,dist[i-w]+10,dist[i-w-1]+14,dist[i-w+1]+14);
    }
    for(let y=h-2;y>0;y--) for(let x=w-2;x>0;x--) {
      const i=y*w+x;if(!mask[i])continue;
      dist[i]=Math.min(dist[i],dist[i+1]+10,dist[i+w]+10,dist[i+w+1]+14,dist[i+w-1]+14);
    }
  }
  for(const r of accepted){
    const edge=r.minX<=box.x+1 ||r.minY<=box.y+1 ||r.maxX>=box.right-2 ||r.maxY>=box.bottom-2;
    if(edge)edgeCount++;
    let candidates=[];
    if(doSplit && r.area>minArea*2.3 && r.area<validCount*.15) {
      for(let y=Math.max(2,r.minY);y<=Math.min(h-3,r.maxY);y++){
        for(let x=Math.max(2,r.minX);x<=Math.min(w-3,r.maxX);x++){
          const i=y*w+x;
          if(labels[i]!==r.id)continue;
          const d=dist[i];
          if(d < Math.max(20,minDiameter*3.2))continue;
          let peak=true;
          for(let dy=-1;dy<=1&&peak;dy++)for(let dx=-1;dx<=1;dx++){
            if(!dx&&!dy)continue;
            const ni=i+dy*w+dx;
            if(dist[ni]>d || (dist[ni]===d&&ni<i)){peak=false;break;}
          }
          if(peak)candidates.push({x,y,d});
        }
      }
      candidates.sort((a,b)=>b.d-a.d);
      // Cap per component to prevent many tiny maxima from generating false duplicates.
      const selected=[];
      for(const p of candidates){
        const pr=p.d/10;
        if(!selected.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<Math.max(minDiameter*.8,1.35*Math.min(pr,q.d/10)))) selected.push(p);
        if(selected.length>=30)break;
      }
      if(selected.length>=2){
        const refArea=typicalArea>0?typicalArea:Math.PI*(selected[0].d/10)**2;
        const areaRatio=r.area/Math.max(1,refArea);
        const peakCircleArea=Math.PI*(selected[0].d/10)**2;
        // Only split if region is clearly bigger than a single candidate disk.
        if((settings.objectShape==='round' || r.aspect>1.45 || areaRatio>1.75)
          && areaRatio>1.45 && r.area>peakCircleArea*1.34){
          // Exclude maxima that are much smaller than the primary object radius.
          let chosen=selected.filter(p=>p.d>selected[0].d*.53);
          // Approximate area-based upper bound prevents aggressive over-segmentation.
          const maxPieces=Math.max(1,Math.ceil(r.area/Math.max(minArea,Math.min(refArea,peakCircleArea)*.58)));
          chosen=chosen.slice(0,Math.min(24,maxPieces));
          if(chosen.length>1) {
            for(const p of chosen) items.push({x:p.x,y:p.y,r:Math.max(4,p.d/10),split:true,edge,
              area:r.area/chosen.length,aspect:Math.max(1,Math.min(1.65,r.aspect/chosen.length)),color:r.color});
            splitExtras+=chosen.length-1;
            continue;
          }
        }
      }
      if(r.area>Math.max(typicalArea*1.9,minArea*5) && r.bw/r.bh>.5 && r.bw/r.bh<2)potentialTouching++;
    }
    items.push({x:r.x,y:r.y,r:Math.sqrt(r.area/Math.PI),split:false,edge,area:r.area,aspect:r.aspect,color:r.color});
  }
  items.sort((a,b)=>a.y-b.y||a.x-b.x);
  const selected=repeatFilter(items,settings,reference);
  const lowContrast=(mode==='background' && noiseMedian>22);
  return {items:selected.items,candidates:items, diagnostics:{repeatMode:selected.groupMode,repeatFiltered:selected.filtered,repeatUncertain:selected.uncertain,background:background.map(x=>Math.round(x)),threshold:Math.round(threshold),otsuThreshold,rawRegions,accepted:accepted.length,filtered:rawRegions-accepted.length,splitExtras,edgeCount,potentialTouching,lowContrast},size:{width:w,height:h}};
}
