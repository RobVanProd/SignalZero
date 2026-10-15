/* Inside an async module scope with THREE from three.js 0.186.1.
 * First-person presentation is a layer around the stateful networking simulation. */
const $ = id => document.getElementById(id);
const simStorageKey = 'signal-zero-3d-v02-run';
const touchDevice = window.matchMedia('(pointer: coarse)').matches;
let sim = new window.SignalZeroSim();
let gameStarted = false;
let activeModal = null;
let activeStation = 'client';
let selectedPorts = [];
let hintReveal = 0;
let toastTimer = null;
let radioTimer = null;
let historyIndex = 0;
const terminalHistory = { client:[], server:[], switch:[], router:[] };
const submittedCommands = { client:[], server:[], switch:[], router:[] };
const stationInfo = {
  client: { name:'DISPATCH-01', title:'CLINIC DISPATCH / WORKSTATION', desc:'A Windows-style client with tools for addressing, reachability, name lookup, and tracing.', tips:['ipconfig /all','ping 10.42.1.20','nslookup clinic.ops.example','tracert 203.0.113.20','curl https://clinic.ops.example/health','curl https://backup.example.net/health'] },
  server: { name:'CORE-SRV', title:'NETWORK SERVICES / APPLIANCE', desc:'Controls DNS and DHCP. This is a simplified training appliance shell, not native Windows or Linux syntax.', tips:['services','dhcp status','dns list'] },
  switch: { name:'ACCESS-SW', title:'ACCESS SWITCH / PORT MANAGEMENT', desc:'Inspect link state and VLAN membership, then configure access ports in the switch CLI.', tips:['show interfaces','show vlan','show mac'] },
  router: { name:'EDGE-RTR', title:'GATEWAY / ROUTING & POLICY', desc:'Inspect route tables, inter-VLAN policy, and the path a guest device can take to clinic equipment.', tips:['show routes','show acl','audit guest'] },
  patch: {name:'PATCH RACK',title:'LAYER 1 / RACK C'},
  map: {name:'CITY NETWORK',title:'TELEMETRY / NETWORK TABLE'}
};
const stations = [
  {id:'client', x:-6.45, z:-3.2, display:'DISPATCH-01', category:'CLIENT'},
  {id:'server', x:-2.15, z:-3.2, display:'CORE-SRV', category:'SERVICES'},
  {id:'switch', x:2.15, z:-3.2, display:'ACCESS-SW', category:'SWITCHING'},
  {id:'router', x:6.45, z:-3.2, display:'EDGE-RTR', category:'ROUTING'},
  {id:'patch', x:-6.45, z:3.1, display:'PATCH RACK', category:'CABLES'},
  {id:'map', x:0, z:1.45, display:'NETWORK TABLE', category:'TOPOLOGY'}
];
const savedRun = (() => {try {return JSON.parse(localStorage.getItem(simStorageKey)||'null')}catch(_){return null}})();
if(savedRun && typeof savedRun === 'object' && savedRun.stage >= 0) $('start-resume').classList.remove('hidden');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030c16);
scene.fog = new THREE.FogExp2(0x040b16,.017);
const camera = new THREE.PerspectiveCamera(69, window.innerWidth / window.innerHeight, .06, 125);
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, powerPreference:'high-performance' });
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,touchDevice?1.4:1.8));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.55;
$('view').append(renderer.domElement);
let yaw=0, pitch=-0.09;
const player={x:0,y:1.72,z:5.5};
const keyHeld={};
let virtualX=0,virtualY=0;
const timer = new THREE.Clock();
const amber=0xffbf79, green=0x64ffbd, red=0xff6e80,blue=0x6acafc, cyan=0x59deda;
const material=(color, emissive=0, intensity=0, metalness=.2, roughness=.58, opacity=1)=>new THREE.MeshStandardMaterial({color, emissive, emissiveIntensity:intensity, metalness, roughness, transparent:opacity<1, opacity});
const MAT={floor:material(0x14202a,0,0,.3,.63),wall:material(0x0b1721,0,0,.4,.72),metal:material(0x243946,0,0,.8,.26),dark:material(0x051019,0,0,.3,.45),display:material(0x0a2534,0x0a3044,.75,.2,.3),glass:material(0x183e52,0x113246,.2,.55,.16,.6),edge:material(0x0b6b77,0x16aaab,.45,.2,.3),bench:material(0x1d2b36,0,0,.5,.55),amber:material(0xffb573,0xbd5b22,.5,.3,.4),red:material(0xdd526e,0x9f1538,.7,.2,.3),green:material(0x55e6a9,0x00d087,.7,.3,.25)};
const dynamic={leds:[],lineSegments:[],monitorPanels:{},monitorScreens:{},cityWindows:[],powerLights:[],holoNodes:[],door:null,ring:null,alarmLight:null,animated:[]};
function box(w,h,d,x,y,z,mat,parent=scene){const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);o.position.set(x,y,z);parent.add(o);return o}
function sphere(r,x,y,z,mat,parent=scene){const o=new THREE.Mesh(new THREE.SphereGeometry(r,12,9),mat);o.position.set(x,y,z);parent.add(o);return o}
function cylinder(r1,r2,h,x,y,z,mat,parent=scene,segments=16){const o=new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,h,segments),mat);o.position.set(x,y,z);parent.add(o);return o}
function lineBetween(a,b,color,width=1){const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a),new THREE.Vector3(...b)]);const l=new THREE.Line(g,new THREE.LineBasicMaterial({color,transparent:true,opacity:width}));scene.add(l);return l}
function textTexture(text,opts={}){
  const c=document.createElement('canvas');c.width=opts.width||512;c.height=opts.height||128;
  const x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);
  if(opts.bg){x.fillStyle=opts.bg;x.fillRect(0,0,c.width,c.height)}
  x.textAlign=opts.align||'center'; x.textBaseline='middle';x.fillStyle=opts.color||'#b9fcf0';x.font=`${opts.bold||850} ${opts.font||34}px ${opts.family||'Consolas, monospace'}`;
  const lines=Array.isArray(text)?text:String(text).split('\n');
  lines.forEach((t,i)=>x.fillText(t,opts.align==='left'?18:c.width/2,(c.height/(lines.length+1))*(i+1),c.width-25));
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=2;return t;
}
function sign(txt,x,y,z,w=2.8,h=.38,opts={}){
  const tex=textTexture(txt,{width:768,height:122,font:opts.font||37,color:opts.color||'#c6eeef',bg:opts.bg||'#112c39',align:'center'});
  const p=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:tex,side:THREE.DoubleSide}));p.position.set(x,y,z);scene.add(p);return p;
}
function monitor(x,y,z,w,h,lines,host){
  const texture=textTexture(lines,{width:650,height:340,font:35,color:'#7be9db',bg:'#041e2a',align:'left'});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));mesh.position.set(x,y,z);scene.add(mesh);dynamic.monitorScreens[host]=mesh;dynamic.monitorPanels[host]=texture;
}
function refreshMonitor(host, lines){const old=dynamic.monitorPanels[host];if(old) old.dispose();const texture=textTexture(lines,{width:650,height:340,font:33,color:'#8af1de',bg:'#051a26',align:'left'});dynamic.monitorScreens[host].material.map=texture;dynamic.monitorScreens[host].material.needsUpdate=true;dynamic.monitorPanels[host]=texture;}
// Architecture: floor, paneling and overhead ducts.
box(20,.3,16,0,-.18,0,MAT.floor);
const grid=new THREE.GridHelper(20,40,0x276475,0x1c3947);grid.position.y=.003;grid.material.transparent=true;grid.material.opacity=.4;scene.add(grid);
box(20,5,.3,0,2.5,8,MAT.wall);box(.3,5,16,-10,2.5,0,MAT.wall);box(.3,5,16,10,2.5,0,MAT.wall);
box(20,.32,16,0,5.5,0,MAT.wall);
for(let x=-9.5;x<10;x+=1){box(.06,.02,15.6,x,5.29,0,material(0x0c343d,0x008da2,.4))}
for(let z=-7;z<=7;z+=3.5){box(19.6,.1,.2,0,5.22,z,MAT.metal);box(19,.035,.035,0,5.06,z+.12,material(0x52e3db,0x16bdac,1.2))}
for(let x of [-8.5,-4.3,0,4.3,8.5]){box(.11,4,.16,x,2.7,7.81,MAT.metal)}
for(let x=-9.5;x<=9.5;x+=2.5){box(2,.06,.1,x,4.7,7.77,material(0x275e6b,0x09978e,.75));box(2,.12,.18,x,.32,7.79,MAT.metal)}
// Window wall, distant city silhouettes and a secured door.
box(20,1.2,.24,0,4.95,-8,MAT.wall);
box(20,.82,.24,0,.42,-8,MAT.wall);
for(let x=-10;x<10;x+=2.5)box(.18,3.6,.35,x,2.7,-7.95,MAT.metal);
const cityMat=[material(0x182838,0x071927,.3,.4,.55),material(0x22394b,0x113444,.4,.25,.5),material(0x0d2639,0x092433,.4,.2,.4)];
for(let i=0;i<26;i++){
  const x=-16+(i*.97),h=2.3+(i*7%8)*.5,z=-12-(i%5)*1.6;
  box(.7+(i%3)*.3,h,.9+(i%4)*.2,x,h/2,z,cityMat[i%3]);
  for(let r=.5;r<h-.3;r+=.43){const ww=box(.06,.12,.025,x-.17,r,z+.57,material(0x2c7e82,0x00a3c1,.5));dynamic.cityWindows.push({mesh:ww,index:i+r,seed:(i*3+Math.floor(r*7))%7});}
}
// Corridor access bulkhead opens as the district recovers.
box(3.2,3.8,.35,8.1,2.28,-7.75,MAT.metal);box(2.6,3.38,.18,8.1,2.28,-7.52,MAT.dark);
const door=box(2.5,3.15,.16,8.1,2.18,-7.34,material(0x2a3c46,0x202c36,.14,.7,.3));dynamic.door=door;
box(.10,3.4,.3,6.7,2.25,-7.36,MAT.edge);box(.10,3.4,.3,9.5,2.25,-7.36,MAT.edge);
sign('SECTOR B  /  ACCESS LOCK',8.05,4.23,-7.32,2.7,.32,{font:31,color:'#ffcaae'});
// Unlockable maintenance corridor: a real place the player can enter once access services recover.
box(3.1,.32,6.7,8.1,-.18,-11.0,MAT.floor);
box(.22,4.7,6.7,6.45,2.3,-11.0,MAT.wall);
box(.22,4.7,6.7,9.9,2.3,-11.0,MAT.wall);
box(3.2,4.7,.27,8.1,2.35,-14.3,MAT.wall);
box(3.25,.20,6.7,8.1,5.04,-11.0,MAT.metal);
for(let z=-8.5;z>=-14;z-=1.0){
  box(2.9,.04,.05,8.12,.04,z,material(0x14717a,0x059c9b,.65));
  box(1.8,.05,.23,8.13,4.86,z,material(0x4edfc4,0x30d3ad,.85));
}
for(let z of [-9.6,-11.2,-12.8]){
  const rack=box(.8,3.2,1,7.05,1.65,z,MAT.metal);
  for(let h=0;h<6;h++){box(.64,.23,.05,7.05,.4+h*.44,z+.56,MAT.dark);box(.08,.06,.025,6.83,.45+h*.44,z+.61,MAT.green)}
  box(.65,2.8,.12,9.42,1.59,z,MAT.display);
}
sign('SECTOR B // BACKUP ARRAY',8.12,3.97,-14.08,3.0,.46,{font:35,color:'#b9f6e4'});
const backupStatus=box(1.4,.14,.10,8.1,2.45,-14.03,MAT.red);
dynamic.backupStatus=backupStatus;
// Ceiling light strips, some will change status along with network services.
const hemi=new THREE.HemisphereLight(0x729eb9,0x0c1418,1.15);scene.add(hemi);
const fill=new THREE.AmbientLight(0x30475c,.65);scene.add(fill);
const emergency=new THREE.PointLight(red,35,17,2);emergency.position.set(-7.8,4.5,3);scene.add(emergency);dynamic.alarmLight=emergency;
for(let i=0;i<5;i++){const x=-8+i*4;const p=new THREE.PointLight(blue,8,10,2);p.position.set(x,4.5,-1.6);scene.add(p);dynamic.powerLights.push(p);box(1.35,.04,.3,x,5.02,-1.6,material(0x72d5e3,0x0b9daa,1.2));}
// Floor route lines carry diegetic position cues.
for(let x of [-7.5,7.5])box(.045,.025,11,x,.04,.15,material(0x378898,0x09b8d1,.6));
box(13,.022,.055,0,.05,-5.1,material(0x3b95a1,0x36ddcf,.65));
for(let i=-7;i<=7;i+=1.5)box(.28,.02,.6,i,.05,5.2,material(0x226575,0x2296a4,.45));
// Workstations have keyboards, a chair, a lit faceplate, and screens whose content changes with network state.
function buildConsole(s){
  const x=s.x,z=s.z;
  const rack=box(3.3,1.08,1.15,x,.55,z-.32,MAT.metal);
  box(3.55,.12,1.47,x,1.12,z-.2,MAT.bench);
  box(2.42,1.45,.13,x,1.97,z-.83,MAT.dark);
  box(2.53,1.55,.18,x,1.97,z-.93,MAT.metal);
  box(2.3,1.29,.03,x,2,z-.817,MAT.display);
  monitor(x,2,z-.795,2.18,1.13,['> boot','status: unknown'],s.id);
  box(1.54,.06,.39,x,1.2,z+.21,MAT.dark);
  for(let i=0;i<13;i++)box(.08,.018,.064,x-.57+i*.095,1.245,z+.19,MAT.metal);
  box(.38,.025,.3,x+1.13,1.2,z+.19,MAT.metal);
  cylinder(.16,.18,.5,x,.8,z+1.1,MAT.metal);
  const chair=box(.92,.13,.63,x,.54,z+1.22,MAT.dark);
  box(.89,.7,.14,x,.95,z+1.58,MAT.metal);chair.rotation.y=.03;
  const faceplate=box(2.95,.27,.075,x,.80,z+.27,MAT.dark);
  for(let i=0;i<10;i++){const led=box(.11,.07,.014,x-1.25+i*.27,.83,z+.316,MAT.red);dynamic.leds.push({mesh:led,station:s.id,index:i})}
  sign(s.display,x,3.02,z-.81,2.9,.44,{font:41,color:'#c5eff7'});
  sign(s.category+' // OPERATE  [E]',x,2.77,z-.81,2.2,.22,{font:24,color:'#73a9b4'});
}
for(const s of stations)if(['client','server','switch','router'].includes(s.id))buildConsole(s);
// Physical patch equipment, ports and power indicators.
const px=-6.45,pz=3.1;
box(3.25,3.2,.78,px,1.67,pz,MAT.metal);
box(2.85,2.78,.08,px,1.72,pz+.44,MAT.dark);
for(let j=0;j<7;j++){
  box(2.5,.25,.12,px,2.74-j*.35,pz+.5,j%2?MAT.metal:MAT.display);
  for(let i=0;i<10;i++){const socket=box(.13,.10,.015,px-1.04+i*.225,2.74-j*.35,pz+.58,MAT.dark);if((j*10+i)%5===0){const led=sphere(.025,px-1.04+i*.225,2.83-j*.35,pz+.60,MAT.red);dynamic.leds.push({mesh:led,station:'patch',index:j+i})}}
}
sign('RACK C  /  PATCH BAY',px,3.68,pz+.57,3.1,.44,{font:37,color:'#bff6ed'});
const cable=new THREE.Mesh(new THREE.TorusGeometry(.43,.035,6,32,Math.PI*1.3),MAT.red);cable.position.set(px,1.18,pz+.74);scene.add(cable);dynamic.animated.push(cable);
// Holographic central tactical map; same network graph as terminals.
const mx=0,mz=1.45;
cylinder(1.65,1.8,.27,mx,.98,mz,MAT.metal);
cylinder(1.4,1.4,.08,mx,1.13,mz,material(0x0a3d4c,0x14a4ac,.65,.55,.2,.6),scene,32);
const holoRing=new THREE.Mesh(new THREE.TorusGeometry(1.27,.025,7,60),new THREE.MeshBasicMaterial({color:cyan}));holoRing.rotation.x=Math.PI/2;holoRing.position.set(mx,1.33,mz);scene.add(holoRing);dynamic.ring=holoRing;
for(let i=0;i<7;i++){
 const a=i/7*Math.PI*2; const node=sphere(.085,mx+Math.cos(a)*.95,1.64+Math.sin(i*3)*.12,mz+Math.sin(a)*.95,material(0x62dfed,0x49dff0,.8));dynamic.holoNodes.push(node);
}
const holoLight=new THREE.PointLight(cyan,3,6,2);holoLight.position.set(0,2.3,1.45);scene.add(holoLight);
sign('CITY NETWORK / LIVE STATE',0,2.62,mz,3.18,.32,{font:32,color:'#c3fff6',bg:'#082634'});
// Floating particulate, low draw-call Points cloud.
const starCount=180;
const stars=new Float32Array(starCount*3);
for(let i=0;i<starCount;i++){stars[i*3]=-9.5+(i*11.45%19);stars[i*3+1]=.3+(i*2.77%4.6);stars[i*3+2]=-7+(i*5.193%14);}
const dustGeo=new THREE.BufferGeometry();dustGeo.setAttribute('position',new THREE.BufferAttribute(stars,3));const dust=new THREE.Points(dustGeo,new THREE.PointsMaterial({color:0x94d9e8,size:.022,transparent:true,opacity:.35,sizeAttenuation:true}));scene.add(dust);

function networkMapMarkup(){
 const st=sim.status,s=sim.s;
 const edges=[
 ['ISP','RTR',st.remoteRouteOK],['RTR','SW',st.linkOK],['SW','PC',st.leaseOK],['SW','SRV',st.linkOK],['SW','GUEST',s.guestVlan===30],['SRV','CLINIC',st.clinicByName]
 ];
 const nodes={ ISP:[85,78,'REMOTE','203.0.113.20'],RTR:[245,78,'EDGE-RTR','10.42.1.1'],SW:[408,178,'ACCESS-SW','VLAN 10/30'],PC:[245,291,'DISPATCH','10.42.1.101'],SRV:[570,78,'CORE-SRV','DHCP + DNS'],GUEST:[570,282,'GUEST-AP','PORT 6'],CLINIC:[737,178,'CLINIC','10.42.1.20']};
 return '<svg viewBox="0 0 825 365" role="img" aria-label="Diagram showing remote backup, router, switch, server, dispatch PC, clinic and guest AP">'+
 edges.map(([a,b,ok])=>{const A=nodes[a],B=nodes[b],klass=ok?'cable':'cable down';return `<line class="${klass}" x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}"></line>`}).join('')+
 Object.entries(nodes).map(([k,n])=>`<g><rect class="node" x="${n[0]-66}" y="${n[1]-29}" width="132" height="58" rx="8"/><text class="nodeLabel" x="${n[0]}" y="${n[1]-5}">${n[2]}</text><text class="nodeSub" x="${n[0]}" y="${n[1]+14}">${n[3]}</text></g>`).join('')+
 `<text x="15" y="350" fill="#8cbdc9" font-size="11" font-family="monospace">GREEN = WORKING REQUIREMENT   //   RED DASH = FAILURE / MISCONFIGURATION</text></svg>`;
}
function updateMap(){const html=networkMapMarkup();$('small-map').innerHTML=html;$('big-map').innerHTML=html;const st=sim.status;$('big-map-note').textContent=`Physical uplink ${st.linkOK?'UP':'DOWN'} · Dispatch ${st.clientIP} · DNS ${sim.s.dnsA} · Guest access ${st.guestSafe?'ISOLATED':'EXPOSED'} · Backup ${st.remoteRouteOK?'REACHABLE':'DOWN'}. Green indicates this simplified scenario's service requirement, not raw wire state.`;}
function telemetryRows(){const st=sim.status;return [['UPLINK',st.linkOK],['DHCP LEASE',st.leaseOK],['CLINIC NAME',st.clinicByName],['GUEST ISOLATION',st.guestSafe],['REMOTE ROUTE',st.remoteRouteOK]].map(([name,ok])=>`<div class="statusline ${ok?'ok':'fail'}"><span>${name}</span><b>${ok?'ONLINE':'FAULT'}</b></div>`).join('')}
function updateMission(){
 const lv=window.SignalZeroLevels[Math.min(sim.stage,4)],st=sim.status;
 $('mission-code').textContent=sim.done?'SHIFT COMPLETE / 05 OF 05':`${String(sim.stage+1).padStart(2,'0')} / 05 · ${lv.code}`;
 $('mission-title').textContent=sim.done?'CITY BACK ONLINE':lv.title;
 $('mission-objective').textContent=sim.done?'Five network faults repaired. All districts operational. Keep exploring or restart to practice.':lv.objective;
 $('mission-pills').innerHTML=[['LINK',st.linkOK],['DHCP',st.leaseOK],['DNS',st.clinicByName],['SECURE',st.guestSafe],['WAN',st.remoteRouteOK]].map(([n,ok])=>`<span class="pill ${ok?'up':'down'}"><span>●</span>${n}</span>`).join('');
 $('district-online').textContent=sim.stage+' / 5';
 $('score').textContent=String(sim.s.score).padStart(4,'0');
 $('telemetry').innerHTML=telemetryRows();
 $('sidebar-note').textContent=sim.done?'All services respond to network state. You can still change equipment and test failure modes.':lv.narrative;
 $('ticker-items').innerHTML=[
  ['PHYSICAL / SW01 UPLINK',st.linkOK?'CARRIER DETECTED':'LINK DOWN'],
  ['DISPATCH / CLIENT',st.leaseOK?'DHCP '+st.clientIP:'UNCONFIGURED '+st.clientIP],
  ['CLINIC / ACCESS',st.clinicByName?'SERVICE RESTORED':'NAME/CONNECTIVITY FAULT'],
  ['GUEST / SECURITY',st.guestSafe?'ACCESS DENIED':'EXPOSURE DETECTED'],
  ['BACKUP / REMOTE',st.remoteRouteOK?'PATH HEALTHY':'NEXT HOP UNAVAILABLE']
 ].slice(0,4).map(([a,b])=>`<div class="ticker-line"><span style="color:#6e9baa">${a}</span><br>${b}</div>`).join('');
 $('checkpoints').innerHTML=window.SignalZeroLevels.map((lev,i)=>`<div class="checkpoint ${i<sim.stage?'done':''}">${i<sim.stage?'✓':'□'} &nbsp; ${String(i+1).padStart(2,'0')} · ${lev.title}</div>`).join('');
 const goal=sim.done?'SIMULATION COMPLETE':lv.skill;
 $('manual-copy').innerHTML=`<h4>${sim.done?'CERTIFICATION SKILL TRANSFER':'CURRENT CONCEPT'}</h4><p>${goal}</p><h4>INCIDENT BRIEF</h4><p>${sim.done?'You have restored five connected networking requirements. Real Network+ preparation needs more scenarios, tools, and validated transfer exercises.':lv.narrative}</p><h4>WHAT GOOD ENGINEERS DO</h4><ul><li>Read the failure symptom, not just the alarm color.</li><li>Collect evidence at the closest useful layer.</li><li>Change one setting at a time and retest from the affected client.</li><li>Verify application behavior and check for collateral damage.</li></ul><h4>COMMAND SET</h4><p>This training build uses Windows-style client commands and a small, fictional network-device CLI. It does not claim to reproduce any vendor's full CLI or real packet timings.</p>`;
 updateMap();
}
function refreshWorld(){
 const st=sim.status,s=sim.s;
 dynamic.powerLights.forEach((light,i)=>{const good=i<sim.stage;light.color.setHex(good?green:(i===0?amber:blue));light.intensity=good?12:4.0;});
 emergency.intensity=sim.done?0:st.linkOK?3:15;
 dynamic.leds.forEach(({mesh,station,index})=>{
  const ok=station==='client'?st.leaseOK:station==='server'?s.dhcpRunning:station==='switch'?st.linkOK:station==='router'?st.remoteRouteOK:st.linkOK;
  mesh.material=ok?MAT.green:MAT.red;
 });
 const enabled=sim.stage>=3;door.userData.open=enabled;if(dynamic.backupStatus)dynamic.backupStatus.material=st.remoteRouteOK?MAT.green:MAT.red;
 dynamic.cityWindows.forEach((w,i)=>{const shouldOn=w.seed < Math.max(1,sim.stage+1) && (i%11!==0);w.mesh.material=shouldOn?MAT.green:MAT.dark;});
 refreshMonitor('client',[`DISPATCH-01  //  CLIENT`,`IP  ${st.clientIP}`,`LAN ${st.linkOK?'LINK UP':'CARRIER DOWN'}`,`CLINIC ${st.clinicByName?'REACHABLE':'UNAVAILABLE'}`,`type help to diagnose`]);
 refreshMonitor('server',['CORE-SRV  //  NETWORK SERVICES',`DHCP ${s.dhcpRunning?'ONLINE':'STOPPED'}`,`DNS  ${s.dnsRunning?'ONLINE':'STOPPED'}`,`A clinic.ops.example → ${s.dnsA}`,`Service mgmt  >`]);
 refreshMonitor('switch',['ACCESS-SW  //  24 PORT','Gi0/1  '+(s.uplink?'UP / 1000':'DOWN / ---'),`Gi0/6  VLAN ${s.guestVlan}`,'CLINIC VLAN 10 / GUEST 30','Show vlan to inspect']);
 refreshMonitor('router',['EDGE-RTR  //  ROUTING',`0/0   via ${s.defaultRoute}`,`GUEST → CLINIC ${st.guestCanReach?'OPEN':'DENIED'}`,`BACKUP ${st.remoteRouteOK?'UP':'DOWN'}`,'Show routes to inspect']);
 updateMission();
 try {localStorage.setItem(simStorageKey,JSON.stringify(sim.serialize()));}catch(_){/* local file storage may be denied */}
}
function openModal(id){
 if(activeModal)closeModal();
 activeModal=id;
 document.exitPointerLock?.();
 $(id).classList.remove('hidden');
 $('interaction').classList.remove('active');
 if(id==='guide'){hintReveal=0;$('guide-hint-copy').classList.add('hidden');}
 if(id==='map-overlay')updateMap();
}
function closeModal(){if(!activeModal)return;$(activeModal).classList.add('hidden');activeModal=null;}
function openStation(host){
 activeStation=host;
 openModal('desktop');
 const info=stationInfo[host];
 $('station-label').textContent=info.name+' / '+info.title;
 $('station-sub').textContent=info.desc;
 $('terminal-head-text').textContent=info.name+'   /   SESSION ACTIVE  /  help · diagnostics · change · verify';
 $('prompt').textContent=host==='client'?'C:\\>':host==='server'?'srv#':host==='switch'?'sw#':'rtr#';
 $('quick-commands').innerHTML='';
 info.tips.forEach(cmd=>{const b=document.createElement('button');b.className='quickcmd';b.textContent='› '+cmd;b.addEventListener('click',()=>runCommand(host,cmd));$('quick-commands').append(b)});
 if(!terminalHistory[host].length){terminalHistory[host].push(`SIGNAL//ZERO TRAINING SHELL   /   ${info.name}`,'────────────────────────────────────────','Type help for supported commands. This is a simulated machine.',info.desc,'');}
 renderTerminal();activateTab('terminal');
 if(!touchDevice)requestAnimationFrame(()=>$('cmd').focus());
}
function renderTerminal(){const out=$('terminalout');out.textContent=terminalHistory[activeStation].join('\n');out.scrollTop=out.scrollHeight;}
function runCommand(host,cmd){
 if(!cmd.trim())return;
 submittedCommands[host].push(cmd);if(submittedCommands[host].length>35)submittedCommands[host].shift();
 historyIndex=submittedCommands[host].length;
 terminalHistory[host].push('');terminalHistory[host].push((host==='client'?'C:\\>':host==='server'?'srv# ':host==='switch'?'sw# ':'rtr# ')+cmd);
 const result=sim.command(host,cmd);
 if(result.clear)terminalHistory[host]=[];
 else terminalHistory[host].push(...result.lines);
 if(terminalHistory[host].length>180)terminalHistory[host]=terminalHistory[host].slice(-180);
 renderTerminal();
 afterAction(result);
}
function radio(text,from='DISPATCH / INTERNAL RADIO'){
  $('radio-speaker').textContent=from;$('radio-content').textContent=text;
  $('radio-message').classList.add('active');
  clearTimeout(radioTimer);radioTimer=setTimeout(()=>$('radio-message').classList.remove('active'),9200);
}
function afterAction(result){
 if(result.changed||result.wins?.length){refreshWorld();}
 if(result.wins?.length)for(const win of result.wins){milestone(win)}
 else if(result.changed){playTone(360,.085,'sine',.035)}
}
function milestone(win){
 const broadcasts=[
 'Carrier restored. Client workstations still have no valid network lease. Get into the services console.',
 'Addresses are working. Clinic staff report that the name still goes to the wrong system.',
 'Clinic HTTPS endpoint responding. Access bulkhead to Sector B released; security just flagged a guest-device probe.',
 'Unauthorized access blocked. The backup array in Sector B still cannot reach the upstream site.',
 'Remote backup is answering HTTPS again. You have brought all five systems online.'
 ];
 radio(broadcasts[win.index],win.nextStage===5?'CITY CONTROL / FINAL REPORT':'CITY CONTROL / SHIFT LEAD');
 if(activeModal==='desktop'||activeModal==='patch'){setTimeout(()=>{if(activeModal==='desktop'||activeModal==='patch')closeModal()},1450)}

 const text=win.nextStage>=5?'ALL DISTRICTS ONLINE':window.SignalZeroLevels[Math.min(win.nextStage,4)].title;
 $('toast-title').textContent=win.nextStage>=5?'CITY RECOVERED':win.title+' — FIXED';
 $('toast-sub').textContent=win.nextStage>=5?'Five connected network incidents cleared. All services restored.':'Now reporting: '+text+'. Follow the changing city alerts.';
 $('progress-toast').classList.add('active');
 clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('progress-toast').classList.remove('active'),4200);
 playTone(555,.14,'sine',.055);setTimeout(()=>playTone(740,.19,'triangle',.045),130);
}
function activateTab(tab){
 document.querySelectorAll('#desktop-tabs .tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
 for(const a of ['terminal','topology','manual'])$(a+'-pane').classList.toggle('hidden',a!==tab);
 if(tab==='topology')updateMap();if(tab==='terminal'&&!touchDevice)$('cmd').focus();
}
function showHint(target){
 const lv=window.SignalZeroLevels[Math.min(sim.stage,4)];
 const el=$(target);hintReveal=Math.min(2,hintReveal+1);
 sim.s.hintsUsed++; if(!sim.done)sim.s.score=Math.max(0,sim.s.score-35);
 el.textContent=sim.done?'All five incidents cleared. Try resetting and solving without hints.':lv.hint[hintReveal-1];
 el.classList.remove('hidden');refreshWorld();
}
function openPatch(){openModal('patch');selectedPorts=[];refreshPortButtons();$('patch-output').textContent='Choose one socket on each device.';}
function refreshPortButtons(){document.querySelectorAll('.port').forEach(b=>{b.classList.toggle('selected',selectedPorts.includes(b.dataset.port));b.classList.toggle('connected',sim.s.uplink&&['gw-lan1','sw-uplink'].includes(b.dataset.port))});}
function doPatch(){if(selectedPorts.length!==2){$('patch-output').textContent='Select exactly two labeled endpoints.';return;}const r=sim.patch(selectedPorts[0],selectedPorts[1]);$('patch-output').textContent=r.lines.join(' ');selectedPorts=[];refreshPortButtons();afterAction(r);}
function soundContext(){try{if(!window.__szAudio)window.__szAudio=new(window.AudioContext||window.webkitAudioContext)();return window.__szAudio;}catch(_){return null}}
function playTone(hz,duration,type='sine',vol=.035){const ctx=soundContext();if(!ctx)return;try{ctx.resume();const o=ctx.createOscillator();const g=ctx.createGain();o.type=type;o.frequency.setValueAtTime(hz,ctx.currentTime);g.gain.setValueAtTime(vol,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+duration);o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+duration+.01)}catch(_){/* unavailable audio */}}
function startRun(resume){
 sim=resume&&savedRun?new window.SignalZeroSim(savedRun):new window.SignalZeroSim();
 if(!resume)try{localStorage.removeItem(simStorageKey)}catch(_){}
 gameStarted=true;$('start').classList.add('hidden');
 player.x=0;player.z=5.5;yaw=0;pitch=-.08;
 refreshWorld();radio('Operator online. Emergency traffic is down. Locate Rack C and inspect the gateway-to-switch uplink.');playTone(440,.16,'triangle',.04);
 if(!touchDevice)renderer.domElement.requestPointerLock?.();
}
function nearestStation(){
 let choice=null,best=1000;
 const fx=-Math.sin(yaw),fz=-Math.cos(yaw);
 for(const s of stations){
  const dx=s.x-player.x,dz=s.z-player.z;const dist=Math.hypot(dx,dz);
  const angle=(dx*fx+dz*fz)/Math.max(.01,dist);
  const maxD=touchDevice?3.65:3.25;
  if(dist<=maxD&&(angle>.08||dist<1.65)&&dist<best){choice=s;best=dist;}
 }
 return choice;
}
function interact(){if(!gameStarted||activeModal)return;const t=nearestStation();if(!t){playTone(180,.13,'sine',.015);return;}playTone(470,.07,'triangle',.04);if(t.id==='patch')openPatch();else if(t.id==='map')openModal('map-overlay');else openStation(t.id);}
function setCameraRotation(){camera.rotation.order='YXZ';camera.rotation.y=yaw;camera.rotation.x=pitch;}
function look(dx,dy){yaw-=dx*.00215;pitch=Math.max(-1.12,Math.min(1.18,pitch-dy*.00205));setCameraRotation();}
function move(dt){
 if(!gameStarted||activeModal)return;
 let side=(keyHeld.d||keyHeld.arrowright?1:0)-(keyHeld.a||keyHeld.arrowleft?1:0)+virtualX;
 let forward=(keyHeld.w||keyHeld.arrowup?1:0)-(keyHeld.s||keyHeld.arrowdown?1:0)-virtualY;
 if(!side&&!forward)return;
 const len=Math.hypot(side,forward);if(len>1){side/=len;forward/=len;}
 const speed=(keyHeld.shift?5:3.35)*dt;
 const moveX=(side*Math.cos(yaw)-forward*Math.sin(yaw))*speed;
 const moveZ=(-side*Math.sin(yaw)-forward*Math.cos(yaw))*speed;
 let nx=Math.max(-9.1,Math.min(9.1,player.x+moveX));
 const gateOpen=sim.stage>=3;
 let nz=Math.max(gateOpen&&nx>6.82 ? -13.75:-6.18,Math.min(7.2,player.z+moveZ));
 if(nz < -7.6) nx=Math.max(6.82,Math.min(9.12,nx));
 // Coarse obstacle collision: stand close enough to a console to interact, never walk through it.
 const blocks=[...stations.filter(s=>s.id!=='map').map(s=>({x:s.x,z:s.z,r:1.0})),{x:0,z:1.45,r:1.34}];
 for(const b of blocks){const dd=Math.hypot(nx-b.x,nz-b.z);if(dd<b.r){const v=Math.max(dd,.0001);nx=b.x+(nx-b.x)/v*b.r;nz=b.z+(nz-b.z)/v*b.r;}}
 player.x=nx;player.z=nz;
}
function updateInteraction(){
 const near=nearestStation();const el=$('interaction');const show=!!near&&!activeModal&&gameStarted;
 el.classList.toggle('active',show);if(show){$('interact-label').textContent=near.display;$('interaction').querySelector('small').innerHTML=`<kbd>${touchDevice?'USE':'E'}</kbd> ${near.id==='patch'?'REWIRE PATCH PANEL':near.id==='map'?'INSPECT NETWORK MAP':'ACCESS MACHINE / TERMINAL'}`;}
}
function gameFrame(){
 const dt=Math.min(timer.getDelta(),.05);const tm=timer.elapsedTime;
 move(dt);camera.position.set(player.x,player.y+(!activeModal&&(keyHeld.w||keyHeld.a||keyHeld.s||keyHeld.d)?Math.sin(tm*9)*.018:0),player.z);setCameraRotation();
 if(dynamic.ring)dynamic.ring.rotation.z=tm*.13;
 if(dynamic.door){const target=dynamic.door.userData.open?9.8:8.1;dynamic.door.position.x+=(target-dynamic.door.position.x)*Math.min(1,dt*2.5);}
 dynamic.holoNodes.forEach((o,i)=>{o.position.y=1.6+Math.sin(tm*1.7+i)*.07;o.material.emissiveIntensity=.45+.35*Math.sin(tm*2+i)});
 if(gameStarted)updateInteraction();
 renderer.render(scene,camera);
}
renderer.setAnimationLoop(gameFrame);
refreshWorld();
window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio||1,touchDevice?1.4:1.8))});
window.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&activeModal){e.preventDefault();closeModal();return;}
 if(e.target?.tagName==='INPUT'){
   if(e.key==='ArrowUp'||e.key==='ArrowDown'){
     e.preventDefault();const list=submittedCommands[activeStation];if(!list?.length)return;
     historyIndex=Math.max(0,Math.min(list.length,historyIndex+(e.key==='ArrowUp'?-1:1)));
     $('cmd').value=list[historyIndex]||'';
   }
   return;
 }
 const k=e.key.toLowerCase();keyHeld[k]=true;
 if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k))e.preventDefault();
 if(!gameStarted||activeModal)return;
 if(k==='e'){e.preventDefault();interact()}
 if(k==='m'){e.preventDefault();openModal('map-overlay')}
 if(k==='h'){e.preventDefault();openModal('guide')}
});
window.addEventListener('keyup',e=>keyHeld[e.key.toLowerCase()]=false);
window.addEventListener('blur',()=>{for(const k of Object.keys(keyHeld))keyHeld[k]=false});
renderer.domElement.addEventListener('click',()=>{if(!touchDevice&&gameStarted&&!activeModal&&document.pointerLockElement!==renderer.domElement)renderer.domElement.requestPointerLock?.()});
document.addEventListener('mousemove',e=>{if(document.pointerLockElement===renderer.domElement&&gameStarted&&!activeModal)look(e.movementX,e.movementY)});
// Right-side touch swipe controls camera. Left-side joystick controls movement.
let touchLookId=null,lastTouch={x:0,y:0};
renderer.domElement.addEventListener('pointerdown',e=>{if(!touchDevice||!gameStarted||activeModal||e.clientX<window.innerWidth*.40)return;touchLookId=e.pointerId;lastTouch={x:e.clientX,y:e.clientY};renderer.domElement.setPointerCapture?.(e.pointerId)});
renderer.domElement.addEventListener('pointermove',e=>{if(e.pointerId!==touchLookId)return;const dx=e.clientX-lastTouch.x,dy=e.clientY-lastTouch.y;look(dx*1.25,dy*1.25);lastTouch={x:e.clientX,y:e.clientY}});
renderer.domElement.addEventListener('pointerup',e=>{if(e.pointerId===touchLookId)touchLookId=null});
renderer.domElement.addEventListener('pointercancel',e=>{if(e.pointerId===touchLookId)touchLookId=null});
const stick=$('stick'),knob=$('stick-knob');let stickPointer=null;
function changeStick(e){const r=stick.getBoundingClientRect();let x=e.clientX-(r.left+r.width/2),y=e.clientY-(r.top+r.height/2);const m=Math.hypot(x,y),max=40;if(m>max){x=x/m*max;y=y/m*max}virtualX=x/max;virtualY=y/max;knob.style.transform=`translate(${x}px,${y}px)`}
stick.addEventListener('pointerdown',e=>{stickPointer=e.pointerId;stick.setPointerCapture(e.pointerId);changeStick(e)});
stick.addEventListener('pointermove',e=>{if(e.pointerId===stickPointer)changeStick(e)});
for(const event of ['pointerup','pointercancel'])stick.addEventListener(event,e=>{if(e.pointerId===stickPointer){stickPointer=null;virtualX=0;virtualY=0;knob.style.transform='translate(0,0)'}});
$('touch-use').addEventListener('click',interact);$('touch-map').addEventListener('click',()=>openModal('map-overlay'));
$('start-new').addEventListener('click',()=>startRun(false));$('start-resume').addEventListener('click',()=>startRun(true));
$('open-guide').addEventListener('click',()=>{if(activeModal==='guide')closeModal();else openModal('guide')});
$('open-map').addEventListener('click',()=>{if(activeModal==='map-overlay')closeModal();else openModal('map-overlay')});
$('close-desktop').addEventListener('click',closeModal);$('close-patch').addEventListener('click',closeModal);$('close-guide').addEventListener('click',closeModal);$('close-map').addEventListener('click',closeModal);
$('desktop-tabs').addEventListener('click',e=>{const tab=e.target.closest('[data-tab]');if(tab)activateTab(tab.dataset.tab)});
$('command-form').addEventListener('submit',e=>{e.preventDefault();const cmd=$('cmd').value.trim();$('cmd').value='';if(cmd)runCommand(activeStation,cmd);if(!touchDevice)$('cmd').focus()});
$('patch').addEventListener('click',e=>{const p=e.target.closest('[data-port]');if(!p)return;const id=p.dataset.port;if(selectedPorts.includes(id))selectedPorts=selectedPorts.filter(x=>x!==id);else if(selectedPorts.length<2)selectedPorts.push(id);else selectedPorts=[id];refreshPortButtons();});
$('patch-submit').addEventListener('click',doPatch);
$('patch-unplug').addEventListener('click',()=>{const r=sim.unpatch();$('patch-output').textContent=r.lines.join(' ');refreshPortButtons();afterAction(r)});
$('open-local-hint').addEventListener('click',()=>showHint('hint-text'));
$('guide-hint').addEventListener('click',()=>showHint('guide-hint-copy'));
$('guide-restart').addEventListener('click',()=>{if(!confirm('Reset every incident and start a new shift?'))return;closeModal();startRun(false)});
// Deterministic public test interface, optional. Does not give player progress for opening devtools.
window.__SIGNAL_ZERO_TEST__={
 snapshot:()=>sim.serialize(),status:()=>sim.status,
 command:(host,cmd)=>{const r=sim.command(host,cmd);afterAction(r);return r},
 patch:(a,b)=>{const r=sim.patch(a,b);afterAction(r);return r},
 getStage:()=>sim.stage, getDevicePositions:()=>stations.map(x=>({...x})),
 setPosition:(x,z)=>{player.x=x;player.z=z},
 openStation,refreshWorld,
 version:'0.2-threejs'
};
console.log('%cSIGNAL//ZERO v0.2: first-person network game ready','color:#7bffdb;font-weight:bold');
