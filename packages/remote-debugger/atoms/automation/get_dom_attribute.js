function(){var AtomExport=(()=>{var l=Object.defineProperty;var c=Object.getOwnPropertyDescriptor;var f=Object.getOwnPropertyNames;var E=Object.prototype.hasOwnProperty;var d=(e,t)=>{for(var n in t)l(e,n,{get:t[n],enumerable:!0})},N=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of f(t))!E.call(e,o)&&o!==n&&l(e,o,{get:()=>t[o],enumerable:!(r=c(t,o))||r.enumerable});return e};var m=e=>N(l({},"__esModule",{value:!0}),e);var _={};d(_,{default:()=>i,isBotError:()=>u});var p=new WeakSet;function u(e){return typeof e=="object"&&e!==null&&p.has(e)}function i(e,t){if(t=t.toLowerCase(),t==="style")return O(e.style.cssText);let n=e.getAttributeNode(t);return n&&n.specified?n.value:null}var b=/[;]+(?=(?:(?:[^"]*"){2})*[^"]*$)(?=(?:(?:[^']*'){2})*[^']*$)(?=(?:[^()]*\([^()]*\))*[^()]*$)/;function O(e){let t=e.split(b),n=[];for(let o of t){let s=o.indexOf(":");if(s>0){let a=[o.slice(0,s),o.slice(s+1)];n.push(a[0].toLowerCase(),":",a[1],";")}}let r=n.join("");return r.charAt(r.length-1)===";"?r:`${r};`}return m(_);})();

try {
  return AtomExport.default.apply(null,arguments);
} catch (e) {
  if (AtomExport.isBotError(e)) {
    throw new Error(JSON.stringify({state: e.state, message: e.message}));
  }
  throw e;
}
}
