import { assertEquals } from 'jsr:@std/assert';
import { makeFaviconAttention } from '../client-solid/lib/favicon-attention.js';
Deno.test('favicon: exact original attributes, aggregate update and late decode fencing',()=>{
  const attributes=new Map([['href','/logo-64.png'],['type','image/png']]);
  const link={getAttribute:k=>attributes.get(k)??null,setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k)};
  const image={};const ctx={drawImage(){},beginPath(){},arc(){},fill(){}};
  const owner=makeFaviconAttention({link,palette:{dot:'#f66',separator:'#fff'},createImage:()=>image,createCanvas:()=>({getContext:()=>ctx,toDataURL:()=> 'data:image/png;test'})});
  owner.update(true);assertEquals(attributes.get('href'),'/logo-64.png');image.onload();assertEquals(attributes.get('href'),'data:image/png;test');
  owner.update(false);assertEquals([...attributes],[['href','/logo-64.png'],['type','image/png']]);
  const late=image.onload;owner.dispose();late();assertEquals(attributes.get('href'),'/logo-64.png');
});

Deno.test('favicon: cleared attention cannot revive on delayed decode, decode/composition failures keep normal resource',()=>{
  for(const failure of ['none','decode','canvas']){
    const original={href:'/original.png',type:'image/x-icon',sizes:'16x16 32x32'},attributes=new Map(Object.entries(original)),image={};
    const link={getAttribute:k=>attributes.get(k)??null,setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k)};
    const ctx={drawImage(){if(failure==='canvas')throw Error('unavailable canvas');},beginPath(){},arc(){},fill(){}};
    const owner=makeFaviconAttention({link,palette:{dot:'#f66',separator:'#fff'},createImage:()=>image,createCanvas:()=>({getContext:()=>ctx,toDataURL:()=> 'data:image/png;test'})});
    owner.update(true);owner.update(false);if(failure==='decode')image.onerror();else image.onload();assertEquals(Object.fromEntries(attributes),original);
    if(failure!=='none'){owner.update(true);assertEquals(Object.fromEntries(attributes),original);}
    owner.dispose();assertEquals(Object.fromEntries(attributes),original);
  }
});
