function(){var AtomExport=(()=>{var T=Object.defineProperty;var R=Object.getOwnPropertyDescriptor;var L=Object.getOwnPropertyNames;var S=Object.prototype.hasOwnProperty;var e=(E,_)=>{for(var O in _)T(E,O,{get:_[O],enumerable:!0})},n=(E,_,O,A)=>{if(_&&typeof _=="object"||typeof _=="function")for(let N of L(_))!S.call(E,N)&&N!==O&&T(E,N,{get:()=>_[N],enumerable:!(A=R(_,N))||A.enumerable});return E};var D=E=>n(T({},"__esModule",{value:!0}),E);var M={};e(M,{default:()=>I,isBotError:()=>t});function I(E){return E.tagName.toLowerCase()}var U=new WeakSet;function t(E){return typeof E=="object"&&E!==null&&U.has(E)}return D(M);})();

try {
  return AtomExport.default.apply(null,arguments);
} catch (e) {
  if (AtomExport.isBotError(e)) {
    throw new Error(JSON.stringify({state: e.state, message: e.message}));
  }
  throw e;
}
}
