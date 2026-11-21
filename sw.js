/* Versioned cache: new releases invalidate older app assets.
 * HTML navigation stays network-first so GitHub updates are seen without re-installing PWA.
 */
const CACHE='smart-counter-v1.1.0';
const BASE=new URL('./',self.location.href);
const FILES=['./','./index.html','./app.css?v=1.0.0','./app.js?v=1.0.0','./detector.worker.js?v=1.1.0','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-180.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES.map(p=>new URL(p,BASE).href))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('smart-counter-')&&key!==CACHE).map(key=>caches.delete(key)))),self.clients.claim()]));
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin||!url.pathname.startsWith(BASE.pathname))return;
  // Network first for all app assets: changed GitHub files are picked up on reopen,
  // even if a developer forgets to bump the version string. Cached copies remain offline.
  event.respondWith(fetch(req,{cache:'no-cache'}).then(res=>{
    if(res.ok){const copy=res.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(req,copy)));}
    return res;
  }).catch(()=>caches.match(req).then(cached=>cached||(req.mode==='navigate'?caches.match(new URL('./index.html',BASE).href):undefined))));
});
