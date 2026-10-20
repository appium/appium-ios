function(){var AtomExport=(()=>{var T=Object.defineProperty;var R=Object.getOwnPropertyDescriptor;var L=Object.getOwnPropertyNames;var S=Object.prototype.hasOwnProperty;var s=(E,e)=>{for(var _ in e)T(E,_,{get:e[_],enumerable:!0})},i=(E,e,_,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let N of L(e))!S.call(E,N)&&N!==_&&T(E,N,{get:()=>e[N],enumerable:!(t=R(e,N))||t.enumerable});return E};var l=E=>i(T({},"__esModule",{value:!0}),E);var a={};s(a,{default:()=>n,isBotError:()=>A});function n(E){let e=document,_=document.documentElement;if(!e.webkitFullscreenEnabled){E(!1);return}if(e.webkitIsFullScreen){E(!0);return}let t=O=>{O.target!==_||!e.webkitIsFullScreen||I(!0)},N=O=>{O.target===_&&I(!!e.webkitIsFullScreen)};function I(O){document.removeEventListener("webkitfullscreenchange",t),_.removeEventListener("webkitfullscreenerror",N),E(O)}document.addEventListener("webkitfullscreenchange",t),_.addEventListener("webkitfullscreenerror",N),_.webkitRequestFullscreen()}var D=new WeakSet;function A(E){return typeof E=="object"&&E!==null&&D.has(E)}return l(a);})();

try {
  return AtomExport.default.apply(null,arguments);
} catch (e) {
  if (AtomExport.isBotError(e)) {
    throw new Error(JSON.stringify({state: e.state, message: e.message}));
  }
  throw e;
}
}
