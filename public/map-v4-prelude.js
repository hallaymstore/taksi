(()=>{'use strict';
if(!window.maplibregl?.Map)return;
const OriginalMap=window.maplibregl.Map;
class TaxiMap extends OriginalMap{
  constructor(opts={}){
    const enhanced={...opts,antialias:true,pitch:Number.isFinite(opts.pitch)?opts.pitch:18};
    super(enhanced);
    window.__HALLAYM_TAXI_MAP__=this;
    this.on('load',()=>{
      try{this.setPadding({top:28,bottom:28,left:28,right:28});}catch{}
      window.dispatchEvent(new CustomEvent('hallaym:map-ready',{detail:{map:this}}));
    });
  }
}
Object.setPrototypeOf(TaxiMap,OriginalMap);
window.maplibregl.Map=TaxiMap;
})();
