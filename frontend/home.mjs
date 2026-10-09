// The landing page's coin field, ported from the Claude Design component "Pakka Landing".
// A fixed WebGL stage: a hero coin that lifts away as you scroll, and a field of coins that
// fall slowly and parallax with scroll depth. Everything is drawn procedurally; no model files.
import * as T from "/lib/three.module.min.js";
import { RoomEnvironment } from "/lib/RoomEnvironment.js";

// A missing photo leaves its tile's own backdrop showing instead of a broken-image icon.
for(const img of document.querySelectorAll(".shot img")){
  const miss=()=>img.parentElement.classList.add("missing");
  if(img.complete&&!img.naturalWidth)miss();else img.addEventListener("error",miss);
}

const stage=document.getElementById("stage"),dim=document.getElementById("dim");
const still=matchMedia("(prefers-reduced-motion: reduce)").matches;
const spin=still?0:1,coinCount=innerWidth<700?24:42;
const cv=(w,h=w)=>{const c=document.createElement("canvas");c.width=w;c.height=h;return [c,c.getContext("2d")];};

// height map -> colour (worn metal), roughness, normal
function bake(hc,S,H,edge){
  const hd=hc.getContext("2d").getImageData(0,0,S,H).data;
  const [cc,cx]=cv(S,H),[rc,rx]=cv(S,H),[nc,nx]=cv(S,H);
  const ci=cx.createImageData(S,H),ri=rx.createImageData(S,H),ni=nx.createImageData(S,H);
  const h=(x,y)=>hd[((((y+H)%H)*S)+((x+S)%S))*4]/255;
  for(let y=0;y<H;y++)for(let x=0;x<S;x++){
    const i=(y*S+x)*4,v=h(x,y),n=(Math.random()-.5)*.08,g=hd[i+1]/255;
    const k=Math.min(1,Math.max(0,v*1.15-.1+n));
    const grime=Math.max(0,.55-v)*.9*(.7+Math.random()*.3);
    ci.data[i]=(92+(228-92)*k)*(1-grime*.5);ci.data[i+1]=(94+(230-94)*k)*(1-grime*.5);ci.data[i+2]=(98+(236-98)*k)*(1-grime*.48);ci.data[i+3]=255;
    const rough=Math.min(1,Math.max(.12,.62-.42*v+grime*.3+(1-g)*.35+n));
    ri.data[i]=ri.data[i+1]=ri.data[i+2]=rough*255;ri.data[i+3]=255;
    const s=edge?3:5,dx=(h(x-1,y)-h(x+1,y))*s,dy=(h(x,y-1)-h(x,y+1))*s,l=Math.hypot(dx,dy,1);
    ni.data[i]=(dx/l*.5+.5)*255;ni.data[i+1]=(-dy/l*.5+.5)*255;ni.data[i+2]=(1/l*.5+.5)*255;ni.data[i+3]=255;
  }
  cx.putImageData(ci,0,0);rx.putImageData(ri,0,0);nx.putImageData(ni,0,0);
  const map=new T.CanvasTexture(cc);map.colorSpace=T.SRGBColorSpace;
  const t=[map,new T.CanvasTexture(rc),new T.CanvasTexture(nc)];t.forEach(x=>x.anisotropy=8);return t;
}
function faceHeight(S){
  const [c,x]=cv(S),C=S/2,u=S/1024;
  x.fillStyle="#000";x.fillRect(0,0,S,S);
  x.fillStyle="rgb(92,255,92)";x.beginPath();x.arc(C,C,512*u,0,7);x.fill();
  x.strokeStyle="rgb(235,255,235)";x.lineWidth=46*u;x.beginPath();x.arc(C,C,488*u,0,7);x.stroke();
  x.strokeStyle="rgb(150,255,150)";x.lineWidth=6*u;x.beginPath();x.arc(C,C,462*u,0,7);x.stroke();
  x.fillStyle="rgb(220,255,220)";for(let i=0;i<150;i++){const a=i/150*Math.PI*2;x.beginPath();x.arc(C+Math.cos(a)*444*u,C+Math.sin(a)*444*u,4.5*u,0,7);x.fill();}
  x.save();x.translate(C,C);x.font=`600 ${46*u}px Geist, Helvetica, sans-serif`;x.textAlign="center";x.textBaseline="middle";x.fillStyle="rgb(230,255,230)";
  const ring="USD COIN  ·  USDC  ·  PAKKA FIXED  ·  31·12·26  ·  ";for(let i=0;i<ring.length;i++){x.save();x.rotate(i/ring.length*Math.PI*2);x.fillText(ring[i],0,-398*u);x.restore();}x.restore();
  x.strokeStyle="rgb(215,255,215)";x.lineWidth=7*u;x.beginPath();x.arc(C,C,352*u,0,7);x.stroke();
  x.strokeStyle="rgb(70,255,70)";x.lineWidth=1.6*u;for(let r=70;r<340;r+=8){x.beginPath();x.arc(C,C,r*u,0,7);x.stroke();}
  // USDC mark: twin arcs + dollar
  x.strokeStyle="rgb(250,255,250)";x.lineCap="round";x.lineWidth=36*u;
  x.beginPath();x.arc(C,C,262*u,-Math.PI*.3,Math.PI*.3);x.stroke();x.beginPath();x.arc(C,C,262*u,Math.PI*.7,Math.PI*1.3);x.stroke();
  x.fillStyle="rgb(250,255,250)";x.font=`600 ${360*u}px Geist, Helvetica, sans-serif`;x.textAlign="center";x.textBaseline="middle";x.fillText("$",C,C+14*u);
  // wear: scratches, dings, softened high points
  for(let i=0;i<420;i++){const a=Math.random()*7,r=Math.random()*470*u,px=C+Math.cos(a)*r,py=C+Math.sin(a)*r,l=(8+Math.random()*70)*u,d=Math.random()*7;
    x.strokeStyle=Math.random()<.7?"rgba(40,120,40,.55)":"rgba(255,255,255,.25)";x.lineWidth=(.6+Math.random()*1.6)*u;x.beginPath();x.moveTo(px,py);x.lineTo(px+Math.cos(d)*l,py+Math.sin(d)*l);x.stroke();}
  for(let i=0;i<26;i++){const a=Math.random()*7,r=(470+Math.random()*30)*u;x.fillStyle="rgba(60,60,60,.7)";x.beginPath();x.arc(C+Math.cos(a)*r,C+Math.sin(a)*r,(3+Math.random()*7)*u,0,7);x.fill();}
  for(let i=0;i<9000;i++){x.fillStyle=`rgba(${Math.random()<.5?0:255},${100+Math.random()*155|0},0,.08)`;x.fillRect(Math.random()*S,Math.random()*S,2*u,2*u);}
  x.filter=`blur(${1.1*u}px)`;x.drawImage(c,0,0);x.filter="none";
  return c;
}
function edgeHeight(W,H){
  const [c,x]=cv(W,H);x.fillStyle="#808080";x.fillRect(0,0,W,H);
  for(let i=0;i<W;i+=8){const g=x.createLinearGradient(i,0,i+8,0);g.addColorStop(0,"#3a3a3a");g.addColorStop(.5,"#f0f0f0");g.addColorStop(1,"#3a3a3a");x.fillStyle=g;x.fillRect(i,0,8,H);}
  for(let i=0;i<40;i++){x.fillStyle="rgba(40,40,40,.6)";x.fillRect(Math.random()*W,Math.random()*H,4+Math.random()*30,1+Math.random()*3);}
  return c;
}

async function boot(){
  // The coin's inscription is drawn with the page font, so wait for it rather than bake a fallback.
  try{await document.fonts.load("600 46px Geist");}catch{}
  const renderer=new T.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=T.SRGBColorSpace;
  renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  stage.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style,{width:"100%",height:"100%",display:"block"});
  const scene=new T.Scene();
  scene.environment=new T.PMREMGenerator(renderer).fromScene(new RoomEnvironment(),.03).texture;scene.environmentIntensity=.9;
  const cam=new T.PerspectiveCamera(35,1,.1,100);cam.position.set(0,0,12);
  const key=new T.DirectionalLight(0xffffff,2.4);key.position.set(4,5,6);scene.add(key);
  const rim=new T.DirectionalLight(0xdfe8ff,3);rim.position.set(-5,3,-6);scene.add(rim);
  scene.add(new T.AmbientLight(0xffffff,.05));
  const [fc,fr,fn]=bake(faceHeight(1024),1024,1024,false);
  const [ec,er,en]=bake(edgeHeight(1024,64),1024,64,true);
  const face=new T.MeshStandardMaterial({map:fc,roughnessMap:fr,normalMap:fn,metalness:1,roughness:1,normalScale:new T.Vector2(1.4,1.4)});
  const edge=new T.MeshStandardMaterial({map:ec,roughnessMap:er,normalMap:en,metalness:1,roughness:1});
  const geo=new T.CylinderGeometry(1,1,.11,128,1);geo.rotateX(Math.PI/2);
  const mk=()=>new T.Mesh(geo,[edge,face,face]);
  const field=new T.Group();scene.add(field);
  const coins=[];
  for(let i=0;i<coinCount;i++){
    const m=mk(),z=-14+Math.random()*13.5,s=.42+Math.random()*.5;
    m.scale.setScalar(s);m.rotation.set(Math.random()*7,Math.random()*7,Math.random()*7);
    coins.push({m,u:Math.random(),xn:Math.random()*2-1,z,sx:(Math.random()-.5)*2,sy:(Math.random()-.5)*2,sz:Math.random()-.5,rate:.4+Math.random()*.9,fall:.006+Math.random()*.01});
    field.add(m);
  }
  const hero=mk();field.add(hero);
  // On a narrow screen the full-size hero coin would sit behind the whole headline.
  const resize=()=>{const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h,false);cam.aspect=w/h;cam.updateProjectionMatrix();hero.scale.setScalar(cam.aspect<1?1.05:1.55);};
  addEventListener("resize",resize);resize();
  let lastY=scrollY,vel=0,prev=performance.now();const t0=prev;
  const tick=()=>{
    const now=performance.now(),dt=Math.min(.05,(now-prev)/1000);prev=now;
    const y=scrollY,dv=y-lastY;lastY=y;vel+=(dv-vel)*.12;
    const boost=Math.min(6,Math.abs(vel)*.06),dir=Math.sign(vel)||1;
    const half=Math.tan(cam.fov*Math.PI/360),vh=innerHeight||800;
    for(const c of coins){
      const dist=12-c.z,hh=half*dist,hw=hh*cam.aspect,span=hh*2.6;
      // parallax: world units per scrolled px at this depth so near coins rush past, far ones drift
      const par=(2*hh/vh)*(.35+.65*(1-dist/26));
      c.u=(c.u+c.fall*dt*spin*.4)%1;
      const py=((c.u*span-y*par)%span+span)%span;
      c.m.position.set(c.xn*hw*1.05,span/2-py,c.z);
      const k=(c.rate*spin*.6+boost*1.4)*dt;
      c.m.rotation.x+=c.sx*k*dir;c.m.rotation.y+=c.sy*k;c.m.rotation.z+=c.sz*k*.5;
    }
    const p=Math.min(1.4,y/vh),t=still?0:(now-t0)/1000;
    hero.position.set(Math.sin(p*1.6)*1.4,p*6.5-.1+Math.sin(t*.8)*.06,2.4-p*2);
    hero.rotation.set(.25+p*2.2+Math.sin(t*.5)*.08,t*.35+p*4.2,-.12+p*.6);
    hero.visible=p<1.35;
    dim.style.opacity=String(Math.min(1,y/(vh*.7))*.55);
    renderer.render(scene,cam);
    requestAnimationFrame(tick);
  };
  tick();
}
// Without WebGL the page is still complete; the stage simply keeps its gradient.
boot().catch(()=>{});
