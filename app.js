(() => {
'use strict';
const $ = id => document.getElementById(id);
const els = {
  liveTab:$('liveTab'),photoTab:$('photoTab'),cameraVideo:$('cameraVideo'),photoCanvas:$('photoCanvas'),overlayCanvas:$('overlayCanvas'),viewerFrame:$('viewerFrame'),viewerTotal:$('viewerTotal'),
  cameraStatus:$('cameraStatus'),modeIndicator:$('modeIndicator'),resolutionText:$('resolutionText'),emptyState:$('emptyState'),emptyTitle:$('emptyTitle'),emptyDescription:$('emptyDescription'),
  analysisState:$('analysisState'),analysisTime:$('analysisTime'),totalCount:$('totalCount'),autoCount:$('autoCount'),manualCount:$('manualCount'),countDescription:$('countDescription'),
  liveActions:$('liveActions'),photoActions:$('photoActions'),startCameraBtn:$('startCameraBtn'),captureBtn:$('captureBtn'),openPhotoBtn:$('openPhotoBtn'),reanalyzeBtn:$('reanalyzeBtn'),imageInput:$('imageInput'),
  switchCameraBtn:$('switchCameraBtn'),selectRoiBtn:$('selectRoiBtn'),resetRoiBtn:$('resetRoiBtn'),saveBtn:$('saveBtn'),editHint:$('editHint'),
  recognitionMode:$('recognitionMode'),objectShape:$('objectShape'),sensitivity:$('sensitivity'),sensitivityVal:$('sensitivityVal'),minSize:$('minSize'),minSizeVal:$('minSizeVal'),
  splitObjects:$('splitObjects'),repeatMode:$('repeatMode'),repeatTolerance:$('repeatTolerance'),repeatToleranceVal:$('repeatToleranceVal'),pickRefBtn:$('pickRefBtn'),clearRefBtn:$('clearRefBtn'),referenceStatus:$('referenceStatus'),resetSettingsBtn:$('resetSettingsBtn'),bgSwatch:$('bgSwatch'),pickBgBtn:$('pickBgBtn'),clearBgBtn:$('clearBgBtn'),
  roiTip:$('roiTip'),busyOverlay:$('busyOverlay'),busyText:$('busyText'),toast:$('toast'),helpDialog:$('helpDialog'),helpBtn:$('helpBtn'),closeHelpBtn:$('closeHelpBtn'),helpBackdrop:$('helpBackdrop'),gotItBtn:$('gotItBtn')
};
const DEFAULTS={recognitionMode:'background',objectShape:'auto',sensitivity:50,minSize:10,splitObjects:true,repeatMode:'auto',repeatTolerance:60};
const state={mode:'live',stream:null,cameraFacing:'environment',cameraWorking:false,liveTimer:0,liveTicking:false,
  worker:null,workerBusy:false,queuedPhoto:false,jobSeq:0,activeJob:null,photoSource:null,results:[],allCandidates:[],reference:null,referencePickMode:false,diagnostics:null,
  roi:null,roiDrag:null,roiMode:false,bgPickMode:false,bgColor:null,manualAdds:[],removed:new Set(),lastImageWidth:0,lastImageHeight:0,
  lastElapsed:0,analysisStarted:false,settings:{...DEFAULTS},toastTimer:0,settingsTimer:0,photoLoading:false};
const analysisCanvas=document.createElement('canvas');
const analysisCtx=analysisCanvas.getContext('2d',{willReadFrequently:true});
const pictureCtx=els.photoCanvas.getContext('2d');
const overlayCtx=els.overlayCanvas.getContext('2d');

function init() {
  loadSettings();renderSettings();bindEvents();initWorker();renderAll();registerSW();
}
function loadSettings(){
  try{const saved=JSON.parse(localStorage.getItem('smart-counter-settings-v1')||'{}');for(const k of Object.keys(DEFAULTS))if(typeof saved[k]===typeof DEFAULTS[k])state.settings[k]=saved[k];}
  catch(_){}
}
function saveSettings(){try{localStorage.setItem('smart-counter-settings-v1',JSON.stringify(state.settings));}catch(_){}}
function renderSettings(){
  const s=state.settings;
  els.recognitionMode.value=s.recognitionMode;els.objectShape.value=s.objectShape;els.sensitivity.value=s.sensitivity;els.minSize.value=s.minSize;
  els.sensitivityVal.textContent=s.sensitivity;els.minSizeVal.textContent=s.minSize+' px';els.splitObjects.checked=s.splitObjects;
  els.repeatMode.value=s.repeatMode;els.repeatTolerance.value=s.repeatTolerance;els.repeatToleranceVal.textContent=s.repeatTolerance;
  els.referenceStatus.textContent=state.reference?'기준 제품이 지정되었습니다. 사진을 다시 분석하면 비슷한 물체만 집계해요.':'기준 없음 · 사진에서 물체 하나를 골라주세요.';
  els.clearRefBtn.disabled=!state.reference;
  els.bgSwatch.style.background=state.bgColor?`rgb(${state.bgColor.join(',')})`:'linear-gradient(135deg,#abb4be,#49515a)';
  els.clearBgBtn.disabled=!state.bgColor;
}
function initWorker(){
  if(state.worker)state.worker.terminate();
  try{
    state.worker=new Worker('./detector.worker.js?v=1.1.0');
    state.worker.onmessage=onWorkerMessage;
    state.worker.onerror=e=>{state.workerBusy=false;showBusy(false);setAnalysisMessage('분석 엔진 오류: 페이지를 새로고침하세요',true);console.error(e);};
  }catch(e){showToast('이 브라우저에서 분석 엔진을 실행할 수 없습니다.');setAnalysisMessage('분석 엔진을 시작할 수 없습니다',true);}
}
function bindEvents(){
  els.liveTab.addEventListener('click',()=>setMode('live'));
  els.photoTab.addEventListener('click',()=>setMode('photo'));
  els.startCameraBtn.addEventListener('click',()=>state.stream?stopCamera(true):startCamera());
  els.captureBtn.addEventListener('click',capturePhoto);
  els.openPhotoBtn.addEventListener('click',()=>els.imageInput.click());
  els.imageInput.addEventListener('change',async e=>{if(e.target.files&&e.target.files[0])await importPhoto(e.target.files[0]);e.target.value='';});
  els.reanalyzeBtn.addEventListener('click',()=>startPhotoAnalysis(true));
  els.switchCameraBtn.addEventListener('click',async()=>{state.cameraFacing=state.cameraFacing==='environment'?'user':'environment';stopCamera(false);await startCamera();});
  els.selectRoiBtn.addEventListener('click',()=>{if(!state.photoSource)return;state.roiMode=!state.roiMode;state.bgPickMode=false;state.referencePickMode=false;renderAll();showToast(state.roiMode?'사진 위에서 영역을 드래그하세요':'영역 지정 취소');});
  els.resetRoiBtn.addEventListener('click',()=>{state.roi=null;state.roiMode=false;startPhotoAnalysis(true);});
  els.pickRefBtn.addEventListener('click',()=>{if(!state.photoSource)return;state.referencePickMode=!state.referencePickMode;state.roiMode=false;state.bgPickMode=false;renderAll();if(state.referencePickMode)els.viewerFrame.scrollIntoView({behavior:'smooth',block:'center'});showToast(state.referencePickMode?'사진 속 기준 물체 한 개를 터치하세요.':'기준 물체 선택을 취소했어요.');});
  els.clearRefBtn.addEventListener('click',()=>{state.reference=null;state.referencePickMode=false;state.settings.repeatMode='auto';saveSettings();renderSettings();startPhotoAnalysis(true);showToast('기준 물체를 해제했어요.');});
  els.pickBgBtn.addEventListener('click',()=>{if(!state.photoSource)return;state.bgPickMode=!state.bgPickMode;state.roiMode=false;state.referencePickMode=false;renderAll();showToast(state.bgPickMode?'물체가 없는 바닥을 한 번 터치하세요':'배경 선택 취소');});
  els.clearBgBtn.addEventListener('click',()=>{state.bgColor=null;renderSettings();if(state.photoSource)startPhotoAnalysis(true);showToast('맞춤 배경 색상을 해제했어요.');});
  els.saveBtn.addEventListener('click',saveResult);
  els.resetSettingsBtn.addEventListener('click',()=>{state.settings={...DEFAULTS};state.bgColor=null;state.reference=null;state.referencePickMode=false;renderSettings();saveSettings();settingsChanged(true);showToast('인식 설정을 초기화했어요.');});
  for(const key of ['recognitionMode','objectShape','sensitivity','minSize','splitObjects','repeatMode','repeatTolerance']) {
    const input=els[key];
    input.addEventListener(key==='sensitivity'||key==='minSize'||key==='repeatTolerance'?'input':'change',()=>{
      state.settings[key]=input.type==='checkbox'?input.checked:input.type==='range'?Number(input.value):input.value;
      if(key==='repeatMode'&&state.settings.repeatMode==='reference'&&!state.reference){
        if(state.mode==='photo'&&state.photoSource){state.referencePickMode=true;els.viewerFrame.scrollIntoView({behavior:'smooth',block:'center'});showToast('사진에서 기준 제품 한 개를 터치하세요.');}
        else showToast('기준 제품은 사진을 촬영한 다음 지정할 수 있어요.');
      }
      renderSettings();saveSettings();settingsChanged(true);renderAll();
    });
  }
  els.viewerFrame.addEventListener('pointerdown',onPointerDown);
  els.viewerFrame.addEventListener('pointermove',onPointerMove);
  els.viewerFrame.addEventListener('pointerup',onPointerUp);
  els.viewerFrame.addEventListener('pointercancel',onPointerCancel);
  window.addEventListener('resize',()=>{drawPhoto();drawOverlay();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopLiveTimer();else if(state.mode==='live'&&state.stream){beginLiveTimer();}});
  window.addEventListener('pagehide',()=>stopCamera(false));
  els.helpBtn.addEventListener('click',()=>toggleHelp(true));
  els.closeHelpBtn.addEventListener('click',()=>toggleHelp(false));
  els.gotItBtn.addEventListener('click',()=>toggleHelp(false));
  els.helpBackdrop.addEventListener('click',()=>toggleHelp(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')toggleHelp(false);});
}
function toggleHelp(open){els.helpDialog.classList.toggle('hidden',!open);}
function settingsChanged(analyze){
  if(!analyze){drawOverlay();return;}
  clearTimeout(state.settingsTimer);
  state.settingsTimer=setTimeout(()=>{
    if(state.mode==='photo'&&state.photoSource)startPhotoAnalysis(true);
    // Live analyzer picks up changed settings in the next camera frame.
  },300);
}
function renderAll(){
  const live=state.mode==='live';
  els.liveTab.classList.toggle('active',live);els.photoTab.classList.toggle('active',!live);
  els.liveTab.setAttribute('aria-selected',String(live));els.photoTab.setAttribute('aria-selected',String(!live));
  els.liveActions.classList.toggle('hidden',!live);els.photoActions.classList.toggle('hidden',live);
  els.modeIndicator.classList.toggle('photo-chip',!live);
  els.modeIndicator.lastChild.textContent=live?' LIVE VIEW':' PHOTO ANALYSIS';
  els.cameraVideo.style.display=(live&&state.stream)?'block':'none';
  els.photoCanvas.style.display=(!live&&state.photoSource)?'block':'none';
  els.emptyState.classList.toggle('hidden',live?!!state.stream:!!state.photoSource);
  els.emptyTitle.textContent=live?'카메라를 시작해 주세요':'사진을 불러오거나 촬영하세요';
  els.emptyDescription.innerHTML=live?'물체들을 평평한 바닥에 놓고<br>위에서 수직으로 촬영하면 좋아요.':'사진을 불러오면 개별 물체를 분석하고<br>터치로 오인식을 수정할 수 있어요.';
  els.startCameraBtn.innerHTML=state.stream?'<span class="button-glyph">◯</span> 카메라 끄기':'<span class="button-glyph">◉</span> 카메라 켜기';
  els.captureBtn.disabled=!state.stream;
  els.switchCameraBtn.disabled=!live||!state.stream;
  els.reanalyzeBtn.disabled=live||!state.photoSource;
  els.selectRoiBtn.disabled=live||!state.photoSource;
  els.resetRoiBtn.disabled=live||!state.photoSource||!state.roi;
  els.saveBtn.disabled=live||!state.photoSource||!state.analysisStarted;
  els.pickBgBtn.disabled=live||!state.photoSource;
  els.pickRefBtn.disabled=live||!state.photoSource||!state.analysisStarted;
  els.clearRefBtn.disabled=!state.reference;
  els.viewerFrame.classList.toggle('reference-active',state.referencePickMode);
  els.selectRoiBtn.classList.toggle('active',state.roiMode);
  els.pickBgBtn.classList.toggle('active',state.bgPickMode);
  els.roiTip.classList.toggle('hidden',!state.roiMode);
  els.viewerFrame.classList.toggle('roi-active',state.roiMode);
  els.editHint.textContent=live?'간격과 정렬에 관계없이 반복되는 물체를 찾습니다. 촬영하면 더 자세히 분석해요.':(state.referencePickMode?'검출할 종류의 제품 하나를 선택하세요.':state.roiMode?'영역을 지정하면 해당 영역 안의 물체만 계산합니다.':state.bgPickMode?'물체가 없는 바닥 부분을 터치하면 배경 기준이 바뀝니다.':'물체 중심의 빨간 점을 눌러 제외하고, 놓친 물체를 눌러 직접 추가하세요.');
  if(!live&&state.photoSource)els.resolutionText.textContent=`${state.photoSource.width} × ${state.photoSource.height}`;
  else if(live&&state.stream&&els.cameraVideo.videoWidth)els.resolutionText.textContent=`${els.cameraVideo.videoWidth} × ${els.cameraVideo.videoHeight}`;
  else els.resolutionText.textContent=live?'카메라 대기 중':'사진 대기 중';
  els.cameraStatus.classList.toggle('on',!!state.stream);
  els.cameraStatus.innerHTML=`<span class="status-light"></span>${state.stream?'카메라 작동 중':'카메라 꺼짐'}`;
  updateCounts();drawPhoto();drawOverlay();
}
function setMode(next){
  if(next===state.mode)return;
  stopLiveTimer();
  if(next==='photo'&&state.stream)stopCamera(false);
  state.mode=next;state.roiMode=false;state.bgPickMode=false;state.referencePickMode=false;
  state.results=[];state.allCandidates=[];state.diagnostics=null;state.analysisStarted=false;
  state.manualAdds=[];state.removed.clear();
  if(next==='photo'&&state.photoSource)startPhotoAnalysis(false);
  else setAnalysisMessage(next==='live'?'카메라를 켜면 분석이 시작됩니다':'사진을 선택하면 분석을 시작합니다');
  renderAll();
}
async function startCamera(){
  if(state.cameraWorking)return;
  state.cameraWorking=true;
  if(!navigator.mediaDevices?.getUserMedia){showToast('카메라는 HTTPS 또는 localhost에서 사용할 수 있습니다.');state.cameraWorking=false;return;}
  try{
    // Explicit user click is important on iPhone Safari.
    const constraints={audio:false,video:{facingMode:{ideal:state.cameraFacing},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:24,max:30}}};
    let stream;
    try{stream=await navigator.mediaDevices.getUserMedia(constraints);}
    catch(err){if(err.name==='OverconstrainedError')stream=await navigator.mediaDevices.getUserMedia({audio:false,video:true});else throw err;}
    state.stream=stream;
    els.cameraVideo.srcObject=stream;
    els.cameraVideo.style.display='block';
    els.cameraVideo.setAttribute('playsinline','');
    try{await els.cameraVideo.play();}catch(err){console.warn('play():',err);}
    const track=stream.getVideoTracks()[0];
    if(track)track.addEventListener('ended',()=>{if(state.stream===stream){stopCamera(true);showToast('카메라 연결이 종료되었어요.');}});
    if(state.mode!=='live')state.mode='live';
    setAnalysisMessage('실시간으로 물체를 확인하고 있어요');
    renderAll();beginLiveTimer();
  }catch(err){
    let message='카메라를 사용할 수 없습니다.';
    if(err.name==='NotAllowedError'||err.name==='PermissionDeniedError')message='카메라 권한이 거부됐어요. Safari 사이트 설정에서 허용해 주세요.';
    if(err.name==='NotFoundError')message='사용 가능한 카메라가 없습니다.';
    if(err.name==='NotReadableError')message='다른 앱에서 카메라를 사용 중일 수 있어요.';
    showToast(message);setAnalysisMessage(message,true);
  }finally{state.cameraWorking=false;renderAll();}
}
function stopCamera(render){
  stopLiveTimer();
  if(state.stream)for(const track of state.stream.getTracks())track.stop();
  state.stream=null;els.cameraVideo.pause();els.cameraVideo.srcObject=null;
  if(render){state.results=[];state.analysisStarted=false;setAnalysisMessage('카메라가 꺼졌어요');renderAll();}
}
function beginLiveTimer(){
  stopLiveTimer();
  state.liveTimer=setInterval(()=>{
    if(state.mode!=='live'||!state.stream||document.hidden||state.workerBusy||els.cameraVideo.readyState<2)return;
    const vw=els.cameraVideo.videoWidth,vh=els.cameraVideo.videoHeight;
    if(!vw||!vh)return;
    const s=Math.min(1,700/Math.max(vw,vh));
    analysisCanvas.width=Math.max(1,Math.round(vw*s));analysisCanvas.height=Math.max(1,Math.round(vh*s));
    analysisCtx.drawImage(els.cameraVideo,0,0,analysisCanvas.width,analysisCanvas.height);
    submitAnalysis('live');
  },620);
}
function stopLiveTimer(){clearInterval(state.liveTimer);state.liveTimer=0;}
function capturePhoto(){
  if(!state.stream || els.cameraVideo.readyState<2){showToast('카메라 영상이 준비되지 않았어요.');return;}
  const vw=els.cameraVideo.videoWidth,vh=els.cameraVideo.videoHeight;
  if(!vw||!vh)return;
  const scale=Math.min(1,1650/Math.max(vw,vh),Math.sqrt(2000000/(vw*vh)));
  const target=document.createElement('canvas');target.width=Math.max(1,Math.round(vw*scale));target.height=Math.max(1,Math.round(vh*scale));
  target.getContext('2d',{willReadFrequently:true}).drawImage(els.cameraVideo,0,0,target.width,target.height);
  stopCamera(false);setPhotoSource(target);
  showToast('촬영했어요! 물체 수량을 정밀 분석합니다.');
}
function setPhotoSource(canvas){
  state.photoSource=canvas;state.mode='photo';state.results=[];state.allCandidates=[];state.reference=null;state.referencePickMode=false;state.roi=null;state.roiDrag=null;state.roiMode=false;state.bgPickMode=false;state.manualAdds=[];state.removed.clear();state.analysisStarted=false;
  if(state.settings.repeatMode==='reference'){state.settings.repeatMode='auto';saveSettings();}renderSettings();
  setAnalysisMessage('사진에서 물체를 검출하고 있어요');
  renderAll();startPhotoAnalysis(false);
}
async function importPhoto(file){
  if(!file.type.startsWith('image/')){showToast('이미지 파일을 선택해 주세요.');return;}
  if(file.size>40*1024*1024){showToast('40MB 이하 사진을 사용해 주세요.');return;}
  state.photoLoading=true;showBusy(true,'사진을 불러오는 중...');
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('사진을 열 수 없습니다.'));img.src=url;});
    const iw=img.naturalWidth,ih=img.naturalHeight;
    if(!iw||!ih)throw new Error('이미지 크기를 확인할 수 없습니다.');
    const s=Math.min(1,1650/Math.max(iw,ih),Math.sqrt(2000000/(iw*ih)));
    const c=document.createElement('canvas');c.width=Math.max(1,Math.round(iw*s));c.height=Math.max(1,Math.round(ih*s));
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(img,0,0,c.width,c.height);
    if(state.stream)stopCamera(false);
    setPhotoSource(c);
  }catch(err){showToast(err.message||'사진을 열지 못했습니다.');}
  finally{URL.revokeObjectURL(url);state.photoLoading=false;if(!state.workerBusy)showBusy(false);}
}
function startPhotoAnalysis(resetManual){
  if(!state.photoSource || state.mode!=='photo')return;
  if(resetManual){state.manualAdds=[];state.removed.clear();}
  state.results=[];state.diagnostics=null;state.analysisStarted=false;
  updateCounts();drawOverlay();
  if(state.workerBusy){state.queuedPhoto=true;showBusy(true);return;}
  analysisCanvas.width=state.photoSource.width;analysisCanvas.height=state.photoSource.height;
  analysisCtx.drawImage(state.photoSource,0,0);
  submitAnalysis('photo');
}
function submitAnalysis(kind){
  if(state.workerBusy||!state.worker)return;
  const w=analysisCanvas.width,h=analysisCanvas.height;
  if(!w||!h)return;
  let imageData;
  try{imageData=analysisCtx.getImageData(0,0,w,h);}catch(e){showToast('이미지를 읽을 수 없습니다.');return;}
  const jobId=++state.jobSeq;state.workerBusy=true;
  state.activeJob={jobId,kind,sourceCanvas:kind==='photo'?state.photoSource:null};
  if(kind==='photo')showBusy(true,'개별 물체 정밀 분석 중...');
  const buffer=imageData.data.buffer;
  try{
    state.worker.postMessage({type:'analyze',jobId,width:w,height:h,rgba:buffer,settings:{...state.settings},roi:kind==='photo'?state.roi:null,bgColor:state.bgColor,reference:kind==='photo'?state.reference:null},[buffer]);
  }catch(err){state.workerBusy=false;showBusy(false);showToast('분석 엔진에 이미지를 전달하지 못했어요.');}
}
function onWorkerMessage(event){
  const msg=event.data;
  const job=state.activeJob;
  if(!job||msg.jobId!==job.jobId)return;
  state.workerBusy=false;state.activeJob=null;
  if(state.queuedPhoto){state.queuedPhoto=false;startPhotoAnalysis(false);return;}
  if(msg.type==='error'){
    showBusy(false);setAnalysisMessage('분석 오류: '+msg.message,true);
    showToast('분석 중 오류가 발생했습니다.');return;
  }
  if(job.kind==='live'&&(state.mode!=='live'||!state.stream))return;
  if(job.kind==='photo'&&(state.mode!=='photo'||job.sourceCanvas!==state.photoSource))return;
  state.results=msg.items||[];
  state.allCandidates=msg.candidates||state.results;
  state.diagnostics=msg.diagnostics;
  state.lastImageWidth=msg.size.width;state.lastImageHeight=msg.size.height;
  state.lastElapsed=msg.ms;state.analysisStarted=true;
  if(job.kind==='photo')showBusy(false);
  const split=msg.diagnostics.splitExtras,edge=msg.diagnostics.edgeCount;
  if(split){setAnalysisMessage(`서로 붙은 물체 ${split}개를 추가로 분리 추정 · 확인 필요`,true);}
  else if(edge){setAnalysisMessage(`분석 완료 · 화면 가장자리의 ${edge}개 물체 확인 권장`,true);}
  else if(msg.diagnostics.lowContrast){setAnalysisMessage('배경 색상 편차가 큽니다. 인식 결과를 확인하세요',true);}
  else if(msg.diagnostics.repeatUncertain){setAnalysisMessage('비슷한 종류를 확정하기 어렵습니다. 기준 물체 선택을 추천해요',true);}
  else if(msg.diagnostics.repeatFiltered){setAnalysisMessage(`반복 제품 ${state.results.length}개 검출 · 다른 후보 ${msg.diagnostics.repeatFiltered}개 제외`);}
  else{setAnalysisMessage(state.results.length?'인식 완료 · 빨간 점 하나가 물체 한 개예요':'물체가 감지되지 않았어요. 설정을 조절해 보세요');}
  els.analysisTime.textContent=msg.ms+' ms';renderAll();
}
function setAnalysisMessage(message,warn=false){
  els.analysisState.classList.toggle('warn',warn);
  els.analysisState.lastElementChild.textContent=message;
}
function showBusy(yes,text){els.busyOverlay.classList.toggle('hidden',!yes);if(text)els.busyText.textContent=text;}
function showToast(message){
  clearTimeout(state.toastTimer);els.toast.textContent=message;els.toast.classList.add('visible');
  state.toastTimer=setTimeout(()=>els.toast.classList.remove('visible'),3300);
}
function updateCounts(){
  const live=state.mode==='live';
  const auto=state.results.length;
  const manual=live?0:state.manualAdds.length-state.removed.size;
  const count=Math.max(0,auto+manual);
  els.totalCount.textContent=count.toLocaleString('ko-KR');
  els.viewerTotal.textContent=count.toLocaleString('ko-KR');
  els.autoCount.innerHTML=`${auto.toLocaleString('ko-KR')}<small>개</small>`;
  els.manualCount.innerHTML=`${manual>0?'+':''}${manual.toLocaleString('ko-KR')}<small>개</small>`;
  els.countDescription.textContent=!state.analysisStarted?'분석을 시작해 주세요':live?'실시간 카메라 자동 추정 결과':manual?'사용자가 인식 결과를 보정했어요':'촬영한 사진의 분석 결과';
  els.saveBtn.disabled=live||!state.photoSource||!state.analysisStarted;
}
function getDisplayMap(sourceW,sourceH){
  const rect=els.viewerFrame.getBoundingClientRect();const W=rect.width,H=rect.height;
  const scale=Math.min(W/sourceW,H/sourceH);
  return {W,H,scale,offsetX:(W-sourceW*scale)/2,offsetY:(H-sourceH*scale)/2};
}
function prepareCanvas(canvas,ctx){
  const rect=els.viewerFrame.getBoundingClientRect();
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const dw=Math.max(1,Math.round(rect.width*dpr)),dh=Math.max(1,Math.round(rect.height*dpr));
  if(canvas.width!==dw||canvas.height!==dh){canvas.width=dw;canvas.height=dh;}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
  return {W:rect.width,H:rect.height};
}
function drawPhoto(){
  const {W,H}=prepareCanvas(els.photoCanvas,pictureCtx);
  if(state.mode!=='photo'||!state.photoSource)return;
  const src=state.photoSource,map=getDisplayMap(src.width,src.height);
  pictureCtx.drawImage(src,map.offsetX,map.offsetY,src.width*map.scale,src.height*map.scale);
}
function displayPoints(){
  const live=state.mode==='live';
  const items=state.results.map((p,i)=>({...p,index:i,manual:false,removed:!live&&state.removed.has(i)}));
  if(!live)for(const p of state.manualAdds)items.push({...p,index:-1,manual:true,removed:false});
  return items;
}
function drawOverlay(){
  prepareCanvas(els.overlayCanvas,overlayCtx);
  const photo=state.mode==='photo';
  const sw=photo?state.photoSource?.width:(els.cameraVideo.videoWidth||state.lastImageWidth);
  const sh=photo?state.photoSource?.height:(els.cameraVideo.videoHeight||state.lastImageHeight);
  if(!sw||!sh)return;
  const {scale,offsetX,offsetY}=getDisplayMap(sw,sh);
  const points=displayPoints();
  for(const p of points) {
    const x=offsetX+(photo?p.x:p.x/Math.max(1,state.lastImageWidth)*sw)*scale;
    const y=offsetY+(photo?p.y:p.y/Math.max(1,state.lastImageHeight)*sh)*scale;
    if(p.removed){
      // Excluded candidates are not red; keep a grey × so they can be restored.
      overlayCtx.beginPath();overlayCtx.moveTo(x-4,y-4);overlayCtx.lineTo(x+4,y+4);
      overlayCtx.moveTo(x+4,y-4);overlayCtx.lineTo(x-4,y+4);
      overlayCtx.strokeStyle='rgba(245,247,249,.8)';overlayCtx.lineWidth=2;overlayCtx.stroke();
      continue;
    }
    const radius=photo?4.7:4.4;
    overlayCtx.beginPath();overlayCtx.arc(x,y,radius,0,Math.PI*2);
    overlayCtx.fillStyle='#f32938';overlayCtx.fill();
    overlayCtx.strokeStyle='#fff';overlayCtx.lineWidth=1.45;overlayCtx.stroke();
  }
  if(photo && (state.roi||state.roiDrag)) {
    const r=state.roiDrag?rectFromDrag(state.roiDrag):state.roi;
    if(r&&r.w>0&&r.h>0){
      const x=offsetX+r.x*sw*scale,y=offsetY+r.y*sh*scale,w=r.w*sw*scale,h=r.h*sh*scale;
      overlayCtx.fillStyle='#41e5b51e';overlayCtx.fillRect(x,y,w,h);
      overlayCtx.strokeStyle='#41e5b5';overlayCtx.lineWidth=2;overlayCtx.setLineDash([7,4]);overlayCtx.strokeRect(x,y,w,h);overlayCtx.setLineDash([]);
    }
  }
}
function photoPointFromEvent(e){
  const src=state.photoSource;if(!src)return null;
  const rect=els.viewerFrame.getBoundingClientRect(),map=getDisplayMap(src.width,src.height);
  const x=(e.clientX-rect.left-map.offsetX)/map.scale;
  const y=(e.clientY-rect.top-map.offsetY)/map.scale;
  if(x<0||y<0||x>=src.width||y>=src.height)return null;
  return {x,y};
}
function onPointerDown(e){
  if(state.mode!=='photo'||!state.photoSource)return;
  const point=photoPointFromEvent(e);if(!point)return;
  if(state.roiMode){state.roiDrag={ax:point.x/state.photoSource.width,ay:point.y/state.photoSource.height,bx:point.x/state.photoSource.width,by:point.y/state.photoSource.height};els.viewerFrame.setPointerCapture(e.pointerId);drawOverlay();}
}
function onPointerMove(e){
  if(!state.roiDrag)return;
  const rect=els.viewerFrame.getBoundingClientRect(),m=getDisplayMap(state.photoSource.width,state.photoSource.height);
  const x=Math.max(0,Math.min(state.photoSource.width,(e.clientX-rect.left-m.offsetX)/m.scale));
  const y=Math.max(0,Math.min(state.photoSource.height,(e.clientY-rect.top-m.offsetY)/m.scale));
  state.roiDrag.bx=x/state.photoSource.width;state.roiDrag.by=y/state.photoSource.height;drawOverlay();
}
function rectFromDrag(d){return {x:Math.min(d.ax,d.bx),y:Math.min(d.ay,d.by),w:Math.abs(d.bx-d.ax),h:Math.abs(d.by-d.ay)};}
function onPointerUp(e){
  if(state.mode!=='photo'||!state.photoSource)return;
  if(state.roiDrag){
    onPointerMove(e);const rect=rectFromDrag(state.roiDrag);state.roiDrag=null;state.roiMode=false;
    if(rect.w>.018&&rect.h>.018){state.roi=rect;showToast('선택한 범위를 다시 분석합니다.');startPhotoAnalysis(true);}
    else showToast('영역을 조금 더 크게 지정해 주세요.');
    renderAll();return;
  }
  const p=photoPointFromEvent(e);if(!p)return;
  if(state.bgPickMode){
    const src=state.photoSource,ctx=src.getContext('2d',{willReadFrequently:true});
    const x=Math.round(p.x),y=Math.round(p.y),x0=Math.max(0,x-3),y0=Math.max(0,y-3);
    const sample=ctx.getImageData(x0,y0,Math.min(7,src.width-x0),Math.min(7,src.height-y0)).data;
    let r=0,g=0,b=0,n=0;
    for(let i=0;i<sample.length;i+=4){r+=sample[i];g+=sample[i+1];b+=sample[i+2];n++;}
    state.bgColor=[Math.round(r/n),Math.round(g/n),Math.round(b/n)];state.bgPickMode=false;renderSettings();showToast('배경 색상 기준을 변경했어요.');startPhotoAnalysis(true);renderAll();return;
  }
  if(!state.analysisStarted){showToast('분석이 끝난 뒤 물체를 수정할 수 있어요.');return;}
  if(state.referencePickMode){
    // Candidate selection also includes those suppressed by automatic grouping.
    let match=null,dist=Infinity;
    for(const candidate of state.allCandidates){
      const d=Math.hypot(candidate.x-p.x,candidate.y-p.y);
      if(d<Math.max(16,candidate.r*1.30)&&d<dist){match=candidate;dist=d;}
    }
    if(!match){showToast('인식된 물체의 가운데를 터치해 주세요. 필요하면 모든 물체 검출 모드를 이용하세요.');return;}
    state.reference={area:match.area,aspect:match.aspect,color:match.color};
    state.referencePickMode=false;state.settings.repeatMode='reference';saveSettings();renderSettings();
    showToast('기준 제품을 설정했어요. 비슷한 물체만 다시 계산합니다.');startPhotoAnalysis(true);renderAll();return;
  }
  const m=getDisplayMap(state.photoSource.width,state.photoSource.height);
  const threshold=Math.max(13/m.scale,9);
  let nearest=null,best=Infinity;
  for(let i=0;i<state.results.length;i++){
    const item=state.results[i],d=Math.hypot(item.x-p.x,item.y-p.y);
    if(d<Math.max(threshold,item.r*1.12)&&d<best){nearest={type:'auto',index:i};best=d;}
  }
  for(let i=0;i<state.manualAdds.length;i++){
    const a=state.manualAdds[i],d=Math.hypot(a.x-p.x,a.y-p.y);
    if(d<threshold&&d<best){nearest={type:'manual',index:i};best=d;}
  }
  if(nearest){
    if(nearest.type==='manual'){state.manualAdds.splice(nearest.index,1);showToast('직접 추가한 표시를 삭제했어요.');}
    else if(state.removed.has(nearest.index)){state.removed.delete(nearest.index);showToast('인식 물체를 다시 포함했어요.');}
    else{state.removed.add(nearest.index);showToast('잘못 인식한 물체를 제외했어요.');}
  }else{
    if(state.roi&&(p.x/state.photoSource.width<state.roi.x||p.x/state.photoSource.width>state.roi.x+state.roi.w||p.y/state.photoSource.height<state.roi.y||p.y/state.photoSource.height>state.roi.y+state.roi.h)){showToast('선택한 분석 영역 안에서 추가해 주세요.');return;}
    state.manualAdds.push({x:p.x,y:p.y,r:Math.max(8,Math.min(23,11/m.scale)),split:false,edge:false});showToast('누락된 물체 1개를 추가했어요.');
  }
  updateCounts();drawOverlay();
}
function onPointerCancel(){state.roiDrag=null;drawOverlay();}
async function saveResult(){
  if(!state.photoSource||!state.analysisStarted)return;
  const src=state.photoSource,footer=Math.max(105,Math.round(src.width*.14));
  const out=document.createElement('canvas');out.width=src.width;out.height=src.height+footer;
  const ctx=out.getContext('2d');ctx.drawImage(src,0,0);
  const points=displayPoints();
  let finalCount=0;
  for(const p of points){
    if(p.removed)continue;
    finalCount++;
    const radius=Math.max(5,src.width*.005);
    ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);
    ctx.fillStyle='#f32938';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1.5,src.width*.0014);ctx.stroke();
  }
  if(state.roi){ctx.strokeStyle='#b1d9cc';ctx.lineWidth=Math.max(2,src.width*.002);ctx.setLineDash([12,7]);ctx.strokeRect(state.roi.x*src.width,state.roi.y*src.height,state.roi.w*src.width,state.roi.h*src.height);ctx.setLineDash([]);}
  const gradient=ctx.createLinearGradient(0,src.height,0,out.height);
  gradient.addColorStop(0,'#101b29');gradient.addColorStop(1,'#050b15');ctx.fillStyle=gradient;ctx.fillRect(0,src.height,src.width,footer);
  ctx.textAlign='center';ctx.fillStyle='#d1d9e4';ctx.textBaseline='middle';
  ctx.font=`bold ${Math.round(footer*.18)}px sans-serif`;ctx.fillText('총 수량',src.width/2,src.height+footer*.20);
  let fontSize=Math.round(footer*.65);
  while(fontSize>16){ctx.font=`900 ${fontSize}px sans-serif`;if(ctx.measureText(String(finalCount)).width<src.width*.88)break;fontSize-=3;}
  ctx.fillStyle='#ffffff';ctx.fillText(finalCount.toLocaleString('ko-KR'),src.width/2,src.height+footer*.62);
  const blob=await new Promise(resolve=>out.toBlob(resolve,'image/png'));
  if(!blob){showToast('이미지 저장에 실패했습니다.');return;}
  const fileName=`smart-counter-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
  try{
    if(navigator.share&&navigator.canShare){
      const file=new File([blob],fileName,{type:'image/png'});
      if(navigator.canShare({files:[file]})){await navigator.share({files:[file],title:'스마트 카운터 분석 결과'});return;}
    }
  }catch(err){if(err.name==='AbortError')return;}
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=fileName;
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
  showToast('결과 이미지 저장을 요청했어요.');
}
function registerSW(){
  if('serviceWorker' in navigator&&location.protocol==='https:'||('serviceWorker' in navigator&&location.hostname==='localhost')){
    navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service worker registration:',err));
  }
}
init();
})();
