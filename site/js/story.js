// The story: 600 dots in a pinned window that change shape over four chapters as you scroll.
// 1 a pile of tokens, 2 one column per server, 3 four clusters (the ways), 4 a spinning ring.
//
// buildStory() works out where every dot sits in each chapter, for the current window size.
// frameStory() runs every animation frame: it turns the scroll position into a point from 0 to 3,
// then draws the dots between the two chapters around that point.
//
// The drawing maths is the approved design. Change it with care, and compare screenshots after.
import data from "../data.js";
import { $, $$, clamp, dprMax, fmt, forced, plural, reduce, usd } from "./util.js";
import { LUT } from "./heat.js";
import { columnServers } from "./values.js";
import { way, ways } from "./ways.js";

const { servers, totals } = data.stats;

const story=$("#story"),body=$("#wbody"),cv=$("#cv"),ctx=cv.getContext("2d"),nav=$("#nav");
const chapsEl=$("#chaps"),chaps=$$(".chap"),legends=$$(".legend");
const hint=$("#hint"),wcmd=$("#wcmd");
const tabBtns=$$(".tabs button");
const CMDS=["stats","stats","bench","proxy"];
const NT=600,LOOP=8,TAU=Math.PI*2,AS=1.6;          /* dots, loop seconds, lattice cell height / width */
const DIM=[112,112,110],BRIGHT=[242,242,240],BG=[21,21,21],GREY=[190,190,186],HOT=[255,150,78],RED=[255,62,88],CREAM=[255,232,200];
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const hash=(i,k)=>{const s=Math.sin(i*12.9898+k*78.233)*43758.5453;return s-Math.floor(s)};
const dly=new Float32Array(NT),swl=new Float32Array(NT),shp=new Float32Array(NT),shk=new Uint8Array(NT),drp=new Float32Array(NT);
for(let i=0;i<NT;i++){dly[i]=hash(i,1);swl[i]=hash(i,2)*2-1;shp[i]=hash(i,3)*TAU;shk[i]=1+Math.floor(hash(i,4)*3);drp[i]=hash(i,5)*TAU}
const mk=()=>({x:new Float32Array(NT),y:new Float32Array(NT),r:new Float32Array(NT),tone:new Float32Array(NT),a:new Float32Array(NT),amb:new Float32Array(NT),h:new Float32Array(NT),sat:new Float32Array(NT)});
const ST=[mk(),mk(),mk(),mk()];

/* mobile: the phone layout, text under the canvas. short: a short screen (a phone on its side), text beside
   the canvas but only its heading. small: either one, so the labels and dots take the compact sizes. */
let W=0,H=0,VH=0,NAV=68,dpr=1,mobile=false,short=false,small=false,Ar=null,storyTop=0,storyH=0;
let lab={},ring=null,dust=[[],[],[],[]],dustScale=100,glow=[null,null,null,null];
/* how far chapter 1 may move up while the window is still rising into view; see frameStory() */
let liftMax=0,lift=0;

/** The height of the nav bar and of the view under it. buildStory() measures them. */
export{NAV as navHeight,VH as viewHeight};

/** How much one dot stands for: `first`, or the next round number (1, 2, 5, 10, ...) that makes count(unit) fit in the dots we have. */
function dotUnit(first,count){
  if(count(first)<=NT)return first;
  for(let e=0;;e++)for(const m of[1,2,5]){const u=m*10**e;if(u>first&&count(u)<=NT)return u}
}

function place(c,list,box){
  const s=ST[c],M=Math.min(list.length,NT);
  list.sort((p,q)=>p.x-q.x||p.y-q.y);
  const pick=new Int16Array(NT).fill(-1);
  for(let k=0;k<M;k++)pick[Math.min(NT-1,Math.floor((k+.5)*NT/M))]=k;
  for(let i=0;i<NT;i++){
    const k=pick[i];
    if(k>=0){const t=list[k];s.x[i]=t.x;s.y[i]=t.y;s.r[i]=t.r;s.tone[i]=t.tone;s.a[i]=1;s.amb[i]=0;s.h[i]=t.h;s.sat[i]=1}
    else{s.x[i]=box.x+hash(i,11)*box.w;s.y[i]=box.y+hash(i,12)*box.h;s.r[i]=.5+hash(i,13)*.8;s.tone[i]=0;s.a[i]=.12+hash(i,14)*.26;s.amb[i]=1;s.h[i]=.5;s.sat[i]=0}
  }
}
function bbox(c){const s=ST[c];let t=1e9,l=1e9,r=-1e9,b=-1e9;for(let i=0;i<NT;i++)if(s.amb[i]<.5&&s.a[i]>.5){t=Math.min(t,s.y[i]-s.r[i]);b=Math.max(b,s.y[i]);l=Math.min(l,s.x[i]-s.r[i]);r=Math.max(r,s.x[i]+s.r[i])}return{t,l,r,b}}
const legendHTML=[
  unit=>'<span><i class="sw b"></i>1 dot = '+fmt(unit)+' tokens of tool results</span><span><i class="sw g"></i>colour = heat of the server that sent them</span>',
  unit=>'<span>1 dot = '+fmt(unit)+' sessions</span><span><i class="sw b"></i>with tool calls</span><span><i class="sw d"></i>idle</span><span><i class="sw g"></i>heat score</span><span><i class="sw r"></i>lost connection</span>',
  unit=>'<span><i class="sw b"></i>1 dot = '+fmt(unit)+' tokens read before the first step</span><span><i class="sw g"></i>colour = cost, hot is cheapest</span>',
  ()=>{const m=way("mirror");return'<span><i class="sw b"></i>'+m.name+': '+plural(m.calls,"tool call")+', '+plural(m.resultTokens,"token")+' back</span><span><i class="sw g"></i>hot = cheap and right</span>'}];

/** Lays the story out for the current window size. Returns false when the story is hidden (a preview link can hide it). */
export function buildStory(){
  if(!body.clientWidth)return false;
  NAV=nav.offsetHeight;VH=window.innerHeight-NAV;
  W=body.clientWidth;H=body.clientHeight;
  dpr=dprMax();
  /* the phone layout (text under the canvas) comes from styles.css, so the canvas and the text always agree */
  const flag=name=>getComputedStyle(body).getPropertyValue(name).trim()==="1";
  mobile=flag("--phone");short=!mobile&&flag("--short");small=mobile||short;
  story.style.height=Math.round(VH*4.7)+"px";
  cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
  const pad=mobile?16:clamp(W*.036,24,44);
  dustScale=Math.min(W,H)*.2;
  let copyW,copyH;
  if(mobile){Object.assign(chapsEl.style,{left:pad+"px",right:pad+"px",width:"",top:"auto",bottom:"16px"});copyH=chapsEl.offsetHeight}   /* the tallest chapter, which is the height of the fade too */
  else{copyW=short?clamp(W*.28,200,250):clamp(W*.31,320,390);Object.assign(chapsEl.style,{left:pad+"px",right:"auto",width:copyW+"px",top:short?"16px":"0",bottom:short?"auto":"0"})}
  /* on a wide window the text sits in the middle of the left side; it may rise until it is `pad` from the top */
  liftMax=small?0:Math.max(0,(H-chaps[0].offsetHeight)/2-pad);
  /* one dot stands for more when the numbers outgrow the 600 dots */
  const unit1=dotUnit(1000,u=>Math.round(totals.tokens/u));
  /* a short screen has room for about five dots in a column, so one dot stands for more there */
  const rows2=u=>Math.max(...columnServers.map(s=>Math.ceil(s.sessions/u)));
  const unit2=dotUnit(small?60:20,u=>short&&rows2(u)>5?NT+1:columnServers.reduce((a,s)=>a+Math.ceil(s.sessions/u),0));
  const unit3=dotUnit(small?20:10,u=>ways.reduce((a,b)=>a+Math.max(1,Math.round(b.defTokens/u)),0));
  const L=[legendHTML[0](unit1),legendHTML[1](unit2),legendHTML[2](unit3),legendHTML[3]()];
  let legH=0;
  legends.forEach((el,i)=>{el.innerHTML=L[i];
    if(mobile){el.style.left=pad+"px";el.style.right=pad+"px";el.style.maxWidth=""}
    else{el.style.right="auto"}
    legH=Math.max(legH,el.offsetHeight)});
  if(mobile){const top=16+legH+14,bot=H-16-copyH-28;   /* the shapes stop where the fade above the text starts (.chaps::before in styles.css) */Ar={x:pad,y:top,w:W-2*pad,h:Math.max(220,bot-top)}}
  else{const x=pad+copyW+clamp(W*.05,36,64),right=W-pad;
    /* a short screen has no room for the legend above the shapes: it goes under the heading, and the margins shrink */
    Ar=short?{x,y:12,w:right-x,h:H-12-28}:{x,y:36,w:right-x,h:H-36-52}}
  const top0=mobile?8:short?0:44,C={x:Ar.x,y:Ar.y+top0,w:Ar.w,h:Ar.h-top0};
  const box={x:Ar.x-24,y:Ar.y,w:Ar.w+48,h:Ar.h};
  lab={};dust=[[],[],[],[]];glow=[null,null,null,null];
  const rnd=(()=>{let s=9;return()=>{s=(s*16807)%2147483647;return(s-1)/2147483646}})();

  /* --- 1: one heavy pile, 1 dot = `unit1` tokens, layered by the heat of the server that sent them --- */
  {
    const N=Math.round(totals.tokens/unit1);
    const prof=x=>Math.pow(Math.max(0,1-Math.pow(Math.abs(x+.04),1.7)),.8);
    const ratio=clamp(C.w/(C.h*.86),mobile?1.15:1.6,2.7);
    let best=null;
    for(let Cn=24;Cn<=80;Cn++){
      let lo=1,hi=200;
      for(let k=0;k<30;k++){const m=(lo+hi)/2;let s=0;for(let j=0;j<Cn;j++)s+=Math.max(1,Math.round(m*prof((j+.5)/Cn*2-1)));s<N?lo=m:hi=m}
      const sc=Math.abs(Cn/(lo*AS)-ratio);
      if(!best||sc<best.sc)best={Cn,hm:lo,sc};
    }
    const{Cn,hm}=best;
    const hs=[];let sm=0;
    for(let j=0;j<Cn;j++){const x=(j+.5)/Cn*2-1,n=(hash(j>>2,22)-.5)*.03*Math.abs(x);const h=Math.max(1,Math.round(hm*(prof(x)+n*prof(x))));hs.push(h);sm+=h}
    for(let g=0;sm!==N&&g<5000;g++){const j=Math.floor(Cn/2+((g*7)%Cn-Cn/2)*.8);if(sm<N){hs[j]++;sm++}else if(hs[j]>1){hs[j]--;sm--}}
    const u=Math.min(C.w/Cn,(mobile?C.h*.86:C.h*.8)/(Math.max(...hs)*AS),mobile?16:22);
    const x0=C.x+(C.w-Cn*u)/2,yb=C.y+C.h-AS*u*(mobile?.6:1.4);
    const rb=.36*u,list=[];let peak={x:0,y:1e9};
    for(let j=0;j<Cn;j++){
      const xn=(j+.5)/Cn*2-1,sl=(hs[Math.min(Cn-1,j+1)]-hs[Math.max(0,j-1)])/2;
      for(let r=0;r<hs[j];r++){
        const depth=hs[j]-1-r;
        const light=.62-.3*xn+.06*sl+(depth===0?.5:depth===1?.22:0)-depth*.025+(hash(j*131+r,23)-.5)*.62;
        const tone=light>.5?1:0,x=x0+(j+.5)*u,y=yb-r*AS*u;
        list.push({x,y,r:tone?rb:rb*.45,tone,h:0,k:(yb-y)/(Math.max(...hs)*AS*u)+(hash(j*977+r,24)-.5)*.22});
        if(depth===0&&y<peak.y)peak={x,y};
      }
    }
    /* hand out the dots: each server gets round(tokens / unit1) of them, hottest servers on top */
    const tokS=servers.filter(s=>s.tokens>0).map(s=>({h:s.heat,n:s.tokens/unit1,c:Math.floor(s.tokens/unit1)}));
    let left=N-tokS.reduce((a,o)=>a+o.c,0);
    tokS.slice().sort((a,b)=>(b.n-b.c)-(a.n-a.c)).forEach(o=>{if(left>0){o.c++;left--}});
    const heats=[];tokS.sort((a,b)=>b.h-a.h).forEach(o=>{for(let q=0;q<o.c;q++)heats.push(o.h)});
    list.slice().sort((a,b)=>b.k-a.k).forEach((t,q)=>t.h=heats[Math.min(q,heats.length-1)]);
    place(0,list,box);
    for(let k=0;k<70;k++){const j=Math.floor(Cn*.25+rnd()*Cn*.7),x=x0+(j+.5)*u,y=yb-(hs[j]-1)*AS*u;dust[0].push({x,y:y-rb,red:rnd()<.12,c:rnd()<.5?CREAM:HOT})}
    lab.pile={x0,x1:x0+Cn*u,base:yb+AS*u*.5,peak,u};
    glow[0]={x:peak.x,y:peak.y+(yb-peak.y)*.3,r:Cn*u*.55,c:HOT,a:.12};
  }

  /* --- 2: one column per server, height = sessions, colour = its heat score --- */
  {
    const Wc=small?1:2,spd=unit2,gap=1;
    const sv=columnServers,n=sv.map(s=>Math.ceil(s.sessions/spd));
    const maxRows=Math.max(...n.map(v=>Math.ceil(v/Wc)));
    const cells=sv.length*Wc+(sv.length-1)*gap;
    const labH=small?124:118,topRoom=small?30:44;
    const u=Math.min(C.w/cells,(C.h-labH-topRoom)/(maxRows*AS),24);
    /* a short screen spaces the columns for their labels, not for their small dots */
    const pitch=short?Math.min(C.w/sv.length,30):(Wc+gap)*u,span=sv.length*pitch-gap*u;
    const x0=C.x+(C.w-span)/2,yb=C.y+C.h-labH;
    const rb=.36*u,list=[];lab.cols=[];
    sv.forEach((s,j)=>{
      const cx0=x0+j*pitch,used=s.sessions-s.idle,usedDots=used>0?Math.max(1,Math.round(used/spd)):0;
      for(let d=0;d<n[j];d++){const row=Math.floor(d/Wc),col=d%Wc,tone=d<usedDots?1:0;
        list.push({x:cx0+(col+.5)*u,y:yb-(row+.5)*AS*u,r:tone?rb:rb*.45,tone,h:s.heat})}
      const topY=yb-Math.ceil(n[j]/Wc)*AS*u,cxm=cx0+Wc*u/2;
      lab.cols.push({x:cxm,top:topY,s});
      const lost=s.drops+s.failed,cnt=Math.min(36,Math.ceil(lost/26));
      for(let k=0;k<cnt;k++)dust[1].push({x:cxm+(rnd()-.5)*Wc*u*.8,y:topY,red:true,c:RED});
    });
    place(1,list,box);
    lab.base=yb;lab.x0=x0;lab.xw=span;
    glow[1]={x:x0+span/2,y:yb,r:span*.6,c:[58,78,236],a:.08};
  }

  /* --- 3: four clusters, size = tokens read first, colour = cost (hot is cheapest) --- */
  {
    const spd=unit3;
    const lo=Math.min(...ways.map(b=>b.costUsd)),hi=Math.max(...ways.map(b=>b.costUsd));
    const ch=ways.map(b=>1-(b.costUsd-lo)/(hi-lo)*.9);
    const nn=ways.map(b=>Math.max(1,Math.round(b.defTokens/spd)));
    const rho=nn.map(v=>Math.sqrt(v*AS/Math.PI)),g=3.2,labH=mobile?50:short?30:64;
    /* each label needs LW px; a window too narrow for four in a row gets two rows of two, like a phone.
       A short screen shows only the names, so its labels need less room. */
    const LW=mobile?156:short?100:160,grid=mobile||C.w<4*LW;
    let u,pos;
    if(!grid){
      const tot=rho.reduce((a,v)=>a+2*v,0)+g*3;
      u=Math.max(1,Math.min(C.w/tot,(C.h-labH-24)/(2*Math.max(...rho)),24));
      const steps=()=>rho.slice(1).map((v,j)=>Math.max((rho[j]+v+g)*u,LW));
      let span;for(let k=0;k<8;k++){span=Math.max(rho[0]*u,LW/2)+steps().reduce((a,v)=>a+v,0)+Math.max(rho[3]*u,LW/2);if(span<=C.w)break;u*=C.w/span}
      const cy=C.y+(C.h-labH)/2,st=steps();
      let cx=C.x+(C.w-span)/2+Math.max(rho[0]*u,LW/2);
      pos=rho.map((r,j)=>{const p={x:cx,y:cy+(Math.max(...rho)-r)*u};cx+=st[j]||0;return p});
    }else{
      const w1=2*rho[0]+2*rho[1]+g,w2=2*rho[2]+2*rho[3]+g,h1=2*Math.max(rho[0],rho[1]),h2=2*Math.max(rho[2],rho[3]);
      u=Math.max(1,Math.min(C.w/Math.max(w1,w2),(C.h-2*labH-26)/(h1+h2),24));   /* never below 1px, even in a tiny window */
      const tH=(h1+h2)*u+2*labH+26,y0=C.y+(C.h-tH)/2;
      const row=(i,j,yTop,h)=>{const d=Math.max((rho[i]+rho[j]+g)*u,LW),mid=C.x+C.w/2,yb=yTop+h*u;return[{x:mid-d/2,y:yb-rho[i]*u},{x:mid+d/2,y:yb-rho[j]*u}]};
      const r1=row(0,1,y0,h1),r2=row(2,3,y0+h1*u+labH+26,h2);
      pos=[r1[0],r1[1],r2[0],r2[1]];
    }
    const list=[];lab.clu=[];
    const baseY=j=>grid?pos[j].y+rho[j]*u:Math.max(...pos.map((p,k)=>p.y+rho[k]*u));
    ways.forEach((b,j)=>{
      const R=Math.ceil(rho[j])+2,cells=[];
      for(let r=-R;r<=R;r++)for(let c=-R;c<=R;c++)cells.push({c,r,m:c*c+r*r*AS*AS+hash(c*31+r,31)*.4});
      cells.sort((p,q)=>p.m-q.m);
      const rb=.36*u;
      cells.slice(0,nn[j]).forEach((q,k)=>{
        const light=.6-.18*q.c/R-.18*q.r/R+(hash(j*977+k,32)-.5)*.7,tone=light>.42?1:0;
        const d=Math.sqrt(q.m)/(rho[j]+1e-6);
        list.push({x:pos[j].x+q.c*u,y:pos[j].y+q.r*AS*u,r:tone?rb:rb*.45,tone,h:clamp(ch[j]+.06-.12*d)});
      });
      lab.clu.push({x:pos[j].x,y:Math.round(baseY(j)+(mobile?18:26)),b});
    });
    place(2,list,box);
    /* the glow sits under the way that won */
    const won=Math.max(0,ways.findIndex(b=>b.best)),m=pos[won];glow[2]={x:m.x,y:m.y,r:rho[won]*u*2.6,c:HOT,a:.14};
  }

  /* --- 4: the ring, burning cream at the core, orange to magenta in the disk --- */
  {
    let cx,cy,R;
    if(mobile){const bot=H-chaps[3].offsetHeight-40,top=C.y;R=Math.min(C.w*.19,(bot-top)*.3);cx=C.x+C.w/2;cy=top+(bot-top)/2}
    else{R=Math.min(C.w*.17,C.h*.21,124);cx=C.x+C.w/2;cy=C.y+C.h*.46}
    R=Math.max(R,12);
    const idx=[...Array(NT).keys()].sort((a,b)=>hash(a,40)-hash(b,40));let k=0;
    const take=n=>idx.slice(k,k+=n);
    ring={cx,cy,R,tilt:-.1,photon:[],disk:[],lens:[],halo:[]};
    take(118).forEach((i,q)=>ring.photon.push({i,a0:q/118*TAU,rho:q%2?1:1.06}));
    const bands=[[1.34,.21,5],[1.56,.22,4],[1.8,.23,4],[2.06,.24,3],[2.36,.25,3]],per=[52,58,64,70,76];
    bands.forEach((bd,bi)=>take(per[bi]).forEach((i,q)=>ring.disk.push({i,rho:bd[0],asp:bd[1],cyc:bd[2],a0:q/per[bi]*TAU+bi*.6,bi})));
    [[1.16,.78,2],[1.3,.7,2]].forEach(bd=>take(30).forEach((i,q)=>ring.lens.push({i,rho:bd[0],asp:bd[1],cyc:bd[2],ph:q/30})));
    idx.slice(k).forEach(i=>ring.halo.push({i,rho:1.25+hash(i,41)*1.5,a0:hash(i,42)*TAU,cyc:1+Math.floor(hash(i,43)*2),r:.6+hash(i,44)*.8,a:.14+hash(i,45)*.26,asp:.3+hash(i,46)*.25}));
    ring.rb=Math.max(1.6,R*.034);
    for(let q=0;q<42;q++){const a=(rnd()-.5)*.5,rr=2.36*R;dust[3].push({x:cx+rr*Math.cos(a),y:cy+rr*.25*Math.sin(a)+rr*Math.cos(a)*Math.sin(-.1),red:rnd()<.5,c:rnd()<.5?HOT:RED})}
    fillRing(0);
    glow[3]={x:cx,y:cy,r:R*2.6,c:[255,90,110],a:.13};
  }
  /* legends sit just above their shapes */
  const extra=[lab.pile?lab.pile.u*1.2+48:0,34,8,10];
  legends.forEach((el,c)=>{
    const bb=bbox(c),h=el.offsetHeight;
    if(mobile){el.style.top=Math.round(Math.max(12,bb.t-extra[c]-h-8))+"px"}
    else if(short){el.style.left=pad+"px";el.style.maxWidth=copyW+"px";el.style.top=Math.round(16+chaps[c].offsetHeight+14)+"px"}
    else{const left=Ar.x;el.style.left=Math.round(left)+"px";el.style.maxWidth=Math.round(W-pad-left)+"px";
      el.style.top=Math.round(Math.max(14,bb.t-extra[c]-el.offsetHeight-10))+"px"}
  });
  if(small)hint.style.display="none";
  else{hint.style.display="";hint.style.left=(Ar.x+Ar.w/2)+"px";hint.style.bottom="18px"}
  return true;
}

function fillRing(t){
  const s=ST[3],q=ring,ct=Math.cos(q.tilt),st=Math.sin(q.tilt),Tt=TAU*t/LOOP;
  const put=(i,ex,ey)=>{s.x[i]=q.cx+ex*ct-ey*st;s.y[i]=q.cy+ex*st+ey*ct};
  const sweep=(a,ph)=>{let d=Math.abs((((a-ph)%TAU)+TAU*1.5)%TAU-Math.PI);d=Math.min(d,TAU-d);return reduce?0:Math.pow(clamp(1-d/.5),1.2)};
  for(const o of q.photon){
    const a=o.a0+Tt,pr=q.R*o.rho;put(o.i,pr*Math.cos(a),pr*Math.sin(a));
    const top=(1-Math.sin(a))/2;
    s.tone[o.i]=o.rho>1?.35+.65*top:1;s.r[o.i]=q.rb*(o.rho>1?.55:.8);s.a[o.i]=1;s.amb[o.i]=0;s.h[o.i]=o.rho>1?.84+.12*top:.97;s.sat[o.i]=1;
  }
  for(const o of q.disk){
    const a=o.a0+Tt*o.cyc,cs=Math.cos(a),sn=Math.sin(a),pr=q.R*o.rho,ex=pr*cs,ey=pr*o.asp*sn;
    put(o.i,ex,ey);
    const front=sn>0,inside=Math.hypot(ex,ey)<q.R*1.02;
    s.tone[o.i]=front?.55+.45*sn:.25;
    s.r[o.i]=q.rb*(front?.7+.5*sn:.5)*(1.1-.12*o.bi);
    s.a[o.i]=!front&&inside?0:1;s.amb[o.i]=0;s.sat[o.i]=1;
    s.h[o.i]=front?clamp(.82-.08*o.bi-.18*(1-sn)+sweep(a,Tt*2+o.bi*.8)*.18):.4-.03*o.bi;
  }
  for(const o of q.lens){
    const u=(o.ph+o.cyc*t/LOOP)%1,a=Math.PI+u*Math.PI,pr=q.R*o.rho;
    put(o.i,pr*Math.cos(a),pr*o.asp*Math.sin(a));
    const edge=Math.sin(u*Math.PI);
    s.tone[o.i]=.25+.5*edge;s.r[o.i]=q.rb*.55;s.a[o.i]=.25+.75*edge;s.amb[o.i]=0;s.h[o.i]=.7;s.sat[o.i]=1;
  }
  for(const o of q.halo){
    const a=o.a0+Tt*o.cyc,pr=q.R*o.rho;put(o.i,pr*Math.cos(a),pr*o.asp*Math.sin(a));
    s.r[o.i]=o.r;s.tone[o.i]=0;s.a[o.i]=o.a;s.amb[o.i]=0;s.h[o.i]=.3;s.sat[o.i]=.8;
  }
}

/* ---------- drawing ---------- */
const mono=(px,w)=>(w||400)+" "+px+'px "Geist Mono",ui-monospace,Menlo,monospace';
const sans=(px,w)=>(w||400)+" "+px+'px "Geist",ui-sans-serif,system-ui,sans-serif';
const rgba=(c,a)=>"rgba("+(c[0]|0)+","+(c[1]|0)+","+(c[2]|0)+","+a.toFixed(3)+")";
function drawGlow(c,w){
  const g=glow[c];if(!g||w<.01||!(g.r>1))return;   /* an early build can see a tiny window */
  const gr=ctx.createRadialGradient(g.x,g.y,0,g.x,g.y,g.r);
  gr.addColorStop(0,rgba(g.c,g.a*w));gr.addColorStop(.55,rgba(g.c,g.a*w*.35));gr.addColorStop(1,rgba(g.c,0));
  ctx.fillStyle=gr;ctx.fillRect(g.x-g.r,g.y-g.r,g.r*2,g.r*2);
}
function draw(t,aC,bC,g){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  drawGlow(aC,1-g);if(bC!==aC)drawGlow(bC,g);
  const A=ST[aC],B=ST[bC],Tt=TAU*t/LOOP;
  for(let i=0;i<NT;i++){
    const loc=reduce?(g>=1?1:0):clamp((g-dly[i]*.42)/.58),f=ease(loc);
    let x=lerp(A.x[i],B.x[i],f),y=lerp(A.y[i],B.y[i],f);
    if(f>0&&f<1){const s=Math.sin(Math.PI*f)*swl[i]*Math.min(W,H)*.08,dx=B.x[i]-A.x[i],dy=B.y[i]-A.y[i],l=Math.hypot(dx,dy)||1;x+=-dy/l*s;y+=dx/l*s}
    const amb=lerp(A.amb[i],B.amb[i],f);
    if(amb>0&&!reduce){x+=Math.cos(Tt*shk[i]+drp[i])*5*amb;y+=Math.sin(Tt*shk[i]+drp[i])*5*amb}
    let r=lerp(A.r[i],B.r[i],f);
    const tone=lerp(A.tone[i],B.tone[i],f),al=lerp(A.a[i],B.a[i],f);
    if(al<.01)continue;
    if(!reduce&&amb<.5)r*=1+.05*Math.sin(Tt*shk[i]+shp[i]);
    y+=(1-tone)*r*1.4*(1-amb);
    /* colour: the heat of what this dot stands for; dim dots sink toward the window */
    const sat=lerp(A.sat[i],B.sat[i],f),k=(clamp(lerp(A.h[i],B.h[i],f))*255|0)*3;
    const pr=LUT[k],pg=LUT[k+1],pb=LUT[k+2];
    const br=lerp(BRIGHT[0],pr,sat),bg=lerp(BRIGHT[1],pg,sat),bb=lerp(BRIGHT[2],pb,sat);
    const dr=lerp(DIM[0],pr*.74+BG[0]*.26,sat),dg=lerp(DIM[1],pg*.74+BG[1]*.26,sat),db=lerp(DIM[2],pb*.74+BG[2]*.26,sat);
    ctx.fillStyle="rgba("+(lerp(dr,br,tone)|0)+","+(lerp(dg,bg,tone)|0)+","+(lerp(db,bb,tone)|0)+","+al.toFixed(2)+")";
    ctx.beginPath();ctx.arc(x,y,r,0,TAU);ctx.fill();
  }
  const wa=1-clamp(g*2.2),wb=clamp(g*2.2-1.2);
  if(wa>.01)drawDust(aC,wa,t);
  if(wb>.01&&bC!==aC)drawDust(bC,wb,t);
  drawLabels(aC,wa);if(bC!==aC)drawLabels(bC,wb);
}
const CYC=new Uint8Array(500),PH=new Float32Array(500),LN=new Float32Array(500),CVv=new Float32Array(500);
for(let i=0;i<500;i++){CYC[i]=1+(i%3);PH[i]=hash(i,51);LN[i]=.55+hash(i,52)*.9;CVv[i]=hash(i,53)}
function drawDust(c,w,t){
  const E=dust[c];if(!E.length)return;
  const wx=.93,wy=-.37,px=-wy,py=wx;
  for(let i=0;i<E.length;i++){
    const e=E[i],age=reduce||forced!=null?PH[i]:((CYC[i]*t/LOOP+PH[i])%1),L=dustScale*LN[i],col=e.red?e.c:GREY;
    for(let j=0;j<(e.red?5:1);j++){
      const a=age-j*.018;if(a<0)continue;
      const d=Math.pow(a,1.15)*L,cu=Math.sin(TAU*(a*1.5+CVv[i]))*.22*d;
      const al=Math.pow(1-a,.9)*w*(a<.06?a/.06:1)*(e.red?(1-j*.17):.6);
      ctx.fillStyle=rgba(e.red?col:e.c||GREY,al);
      ctx.beginPath();ctx.arc(e.x+wx*d+px*cu,e.y+wy*d+py*cu,(e.red?1.8:1.3)*(1-j*.14),0,TAU);ctx.fill();
    }
  }
}
function tick(x,y0,y1,c,a){ctx.strokeStyle=rgba(c,a);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(Math.round(x)+.5,y0);ctx.lineTo(Math.round(x)+.5,y1);ctx.stroke()}
function drawLabels(c,w){
  if(w<.02)return;
  ctx.textBaseline="alphabetic";
  if(c===0){
    const P=lab.pile;
    ctx.strokeStyle=rgba(DIM,.4*w);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(P.x0,Math.round(P.base)+.5);ctx.lineTo(P.x1,Math.round(P.base)+.5);ctx.stroke();
    tick(P.x0,P.base-3,P.base+4,DIM,.5*w);tick(P.x1,P.base-3,P.base+4,DIM,.5*w);
    const ly=Math.round(P.peak.y-P.u*1.2-28);
    tick(P.peak.x,ly+8,P.peak.y-P.u*.9,HOT,.7*w);
    ctx.textAlign="center";ctx.fillStyle=rgba(BRIGHT,w);ctx.font=mono(mobile?12:13,500);ctx.fillText(plural(totals.tokens,"token"),Math.round(P.peak.x),ly);
    ctx.textAlign="left";ctx.fillStyle=rgba([150,150,145],w);ctx.font=mono(11);
    if(!mobile){ctx.fillText(plural(totals.servers,"server"),Math.round(P.x0),Math.round(P.base+20));ctx.textAlign="right";ctx.fillText(plural(totals.calls,"tool call"),Math.round(P.x1),Math.round(P.base+20))}
  }
  if(c===1){
    ctx.strokeStyle=rgba(DIM,.45*w);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(lab.x0-6,Math.round(lab.base)+8.5);ctx.lineTo(lab.x0+lab.xw+6,Math.round(lab.base)+8.5);ctx.stroke();
    let prev=null;   /* the last flag drawn: a flag that would touch it moves up one line */
    lab.cols.forEach(o=>{
      const x=Math.round(o.x);
      if(small){   /* narrow columns: one rotated label, name then sessions */
        ctx.save();ctx.translate(x+3.5,Math.round(lab.base+16));ctx.rotate(Math.PI/2);ctx.textAlign="left";
        ctx.fillStyle=rgba([170,170,165],w);ctx.font=sans(10.5);ctx.fillText(o.s.name,0,0);
        const nw=ctx.measureText(o.s.name+"  ").width;ctx.fillStyle=rgba(BRIGHT,w*.92);ctx.font=mono(9.5);ctx.fillText(fmt(o.s.sessions),nw,0);ctx.restore();
      }else{
        ctx.textAlign="center";ctx.fillStyle=rgba(BRIGHT,w*.92);ctx.font=mono(11);
        ctx.fillText(fmt(o.s.sessions),x,Math.round(lab.base+26));
        ctx.save();ctx.translate(x+4,Math.round(lab.base+36));ctx.rotate(Math.PI/2);ctx.textAlign="left";
        ctx.fillStyle=rgba([160,160,155],w);ctx.font=sans(12);ctx.fillText(o.s.name,0,0);ctx.restore();
      }
      const flag=o.s.drops>=400?fmt(o.s.drops)+" drops":o.s.failed>=50?fmt(o.s.failed)+" failed":null;
      if(flag){
        let ty=Math.round(o.top-(small?10:14));const edge=o.x>lab.x0+lab.xw-30;
        ctx.font=mono(small?9.5:11,500);ctx.fillStyle=rgba(HOT,w);ctx.textAlign=edge?"right":"center";
        const tw=ctx.measureText(flag).width,tx=edge?x+(small?6:12):x,left=edge?tx-tw:tx-tw/2;
        if(prev&&left<prev.right+6&&Math.abs(ty-prev.ty)<14)ty=prev.ty-14;
        prev={right:left+tw,ty};
        ctx.fillText(flag,tx,ty-6);
        tick(x,ty,o.top-2,HOT,.6*w);
      }
    });
  }
  if(c===2){
    lab.clu.forEach(o=>{
      const x=Math.round(o.x),b=o.b;
      ctx.textAlign="center";
      ctx.fillStyle=rgba(b.best?HOT:BRIGHT,w);ctx.font=sans(mobile?13:15,600);ctx.fillText(b.name,x,o.y);
      if(short)return;
      ctx.fillStyle=rgba([150,150,145],w);ctx.font=mono(mobile?10.5:12);
      ctx.fillText(fmt(b.defTokens)+" tok first",x,o.y+(mobile?15:19));
      ctx.fillStyle=rgba(BRIGHT,w*.9);
      ctx.fillText(b.ok+"/"+b.runs+" right · "+usd(b.costUsd),x,o.y+(mobile?30:37));
    });
  }
}

/* ---------- scroll to progress ---------- */
let p=0,lastT=0,aC=0,bC=0,gg=0,lastCur=-1;
const progress=()=>forced!=null?forced:clamp((scrollY-(storyTop-NAV))/VH,0,3);
function phase(){
  const a=Math.min(Math.floor(p+1e-6),2),frac=p-a;
  aC=a;bC=Math.min(a+1,3);gg=clamp((frac-.35)/.3);
  if(p>=3){aC=2;bC=3;gg=1}
}
/** Reads where the story is on the page. Call it again when the layout above it may have changed. */
export function measureStory(){
  storyTop=story.getBoundingClientRect().top+scrollY;storyH=story.offsetHeight;
}
/** Where to scroll to for the start of the story, or for chapter 0 to 3. */
export function storyScrollTop(chapter){
  return storyTop-NAV+(chapter==null?0:(chapter<3?chapter+.1:3.15)*VH);
}
/** One frame. `now` is the animation clock in ms. With `snap`, the story jumps to the scroll position instead of easing to it. */
export function frameStory(now,snap){
  const tgt=progress(),target=reduce?Math.round(tgt):tgt;
  if(snap||reduce)p=target;
  else{
    const dt=Math.min(.05,(now-lastT)/1000||.016);
    p=p+(target-p)*(1-Math.exp(-dt*7));
    if(Math.abs(target-p)<.0005)p=target;
  }
  if(now)lastT=now;
  phase();
  const t=forced!=null||reduce?2.2:(now||0)/1000;
  const y=scrollY,vis=y+innerHeight>storyTop&&y+NAV<storyTop+storyH;
  if(vis||snap){
    if(bC===3)fillRing(t);
    draw(t,aC,bC,gg);
    const cur=gg<.5?aC:bC;
    chaps.forEach((el,k)=>{
      const w=k===aC?1-clamp(gg*2.4):k===bC?clamp(gg*2.4-1.4):0,o=reduce?(k===cur?1:0):w;
      el.style.opacity=o.toFixed(3);el.style.transform="translateY("+((1-o)*16).toFixed(1)+"px)";
      el.classList.toggle("on",o>.5);el.inert=o<=.5;
    });
    legends.forEach((el,k)=>{const w=k===aC?1-clamp(gg*2.2):k===bC?clamp(gg*2.2-1.2):0;el.style.opacity=(reduce?(k===cur?1:0):w).toFixed(3)});
    if(cur!==lastCur){lastCur=cur;tabBtns.forEach((b,k)=>b.setAttribute("aria-current",k===cur?"true":"false"));wcmd.innerHTML='<span>$</span> mcp-faster '+CMDS[cur]}
    hint.style.opacity=p<.06?1:0;
    /* Before the window is pinned, part of it is still below the fold, and text in its middle would be
       out of sight. So the text moves up by the height that is still hidden, at most to the top padding.
       It follows the scroll position itself, not a timer: the text holds still on screen while the
       window rises around it, and it is back in the middle at the moment the window pins. */
    const up=clamp(storyTop-NAV-y,0,liftMax);
    if(up!==lift){lift=up;chapsEl.style.transform=up?"translateY("+(-up).toFixed(1)+"px)":""}
  }
}
