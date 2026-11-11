// One page-lifetime favicon owner. Failures always retain the original icon.
export function makeFaviconAttention({ link, palette, createImage, createCanvas }) {
  const original=Object.fromEntries(['href','type','sizes'].map(key=>[key,link.getAttribute(key)]));
  let active=true, attention=false, composition=null;
  const restore=()=>{for(const[key,value]of Object.entries(original))if(value===null)link.removeAttribute(key);else link.setAttribute(key,value);};
  const apply=()=>{if(active&&attention&&composition){link.setAttribute('href',composition);link.setAttribute('type','image/png');link.setAttribute('sizes','64x64');}else restore();};
  const image=createImage();
  image.onload=()=>{
    if(!active)return;
    try{const canvas=createCanvas();canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');
      ctx.drawImage(image,0,0,64,64);ctx.beginPath();ctx.arc(50,14,14,0,Math.PI*2);ctx.fillStyle=palette.separator;ctx.fill();
      ctx.beginPath();ctx.arc(50,14,10,0,Math.PI*2);ctx.fillStyle=palette.dot;ctx.fill();composition=canvas.toDataURL('image/png');apply();
    }catch{composition=null;restore();}
  };
  image.onerror=()=>{if(active){composition=null;restore();}};
  image.src=original.href;
  return {update(value){attention=!!value;if(active)apply();},dispose(){active=false;image.onload=image.onerror=null;restore();}};
}
