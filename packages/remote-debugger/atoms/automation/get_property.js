function(){var AtomExport=(()=>{var i=Object.defineProperty;var a=Object.getOwnPropertyDescriptor;var u=Object.getOwnPropertyNames;var c=Object.prototype.hasOwnProperty;var f=(e,t)=>{for(var o in t)i(e,o,{get:t[o],enumerable:!0})},E=(e,t,o,s)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of u(t))!c.call(e,n)&&n!==o&&i(e,n,{get:()=>t[n],enumerable:!(s=a(t,n))||s.enumerable});return e};var d=e=>E(i({},"__esModule",{value:!0}),e);var h={};f(h,{default:()=>r,isBotError:()=>l});var N=new WeakSet;function l(e){return typeof e=="object"&&e!==null&&N.has(e)}function r(e,t){return e[t]}return d(h);})();

try {
  return AtomExport.default.apply(null,arguments);
} catch (e) {
  if (AtomExport.isBotError(e)) {
    throw new Error(JSON.stringify({state: e.state, message: e.message}));
  }
  throw e;
}
}
