const fs = require('node:fs');

// Working review crops only. Full captures remain the deliverables; these clips
// let the reviewer inspect every visible region at native detail without a collage.
async function captureReviewRegions(cdp, root, name) {
  const regions = await cdp.evaluate(`(()=>{const regions=[],add=(name,r)=>{const x=Math.max(0,r.x),y=Math.max(0,r.y),right=Math.min(innerWidth,r.x+r.width),bottom=Math.min(innerHeight,r.y+r.height);if(right>x&&bottom>y)regions.push({name,clip:{x,y,width:right-x,height:bottom-y,scale:2}})};for(const [name,selector] of [['title','.vz-title'],['catalogue','.vz-catalogue'],['editors','.vz-sliders'],['summary','.vz-right'],['close','.vz-close'],['decision','.vz-discard']]){const el=document.querySelector(selector);if(el)add(name,el.getBoundingClientRect())}const modal=document.querySelector('.vz-root > .modal-panel')?.getBoundingClientRect();if(modal){add('background-header',{x:0,y:0,width:innerWidth,height:modal.top});add('background-left',{x:0,y:modal.top,width:modal.left,height:innerHeight-modal.top});add('background-right',{x:modal.right,y:modal.top,width:innerWidth-modal.right,height:innerHeight-modal.top});add('background-footer',{x:modal.left,y:modal.bottom,width:modal.width,height:innerHeight-modal.bottom})}return regions})()`);
  const directory = `${root}/review/${name}`; fs.mkdirSync(directory, { recursive: true });
  for (const { name: region, clip } of regions) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(`${directory}/${region}.png`, Buffer.from(data, 'base64'));
  }
}
module.exports = { captureReviewRegions };
