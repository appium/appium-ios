function(){var AtomExport=(()=>{var l=Object.defineProperty;var c=Object.getOwnPropertyDescriptor;var f=Object.getOwnPropertyNames;var E=Object.prototype.hasOwnProperty;var d=(e,t)=>{for(var n in t)l(e,n,{get:t[n],enumerable:!0})},N=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of f(t))!E.call(e,o)&&o!==n&&l(e,o,{get:()=>t[o],enumerable:!(r=c(t,o))||r.enumerable});return e};var m=e=>N(l({},"__esModule",{value:!0}),e);var g={};d(g,{default:()=>s,isBotError:()=>u});var p=new WeakSet;function u(e){return typeof e=="object"&&e!==null&&p.has(e)}function a(e,t){return e[t]}function i(e,t){return e instanceof HTMLFormElement?e.nodeType===Node.ELEMENT_NODE&&(!t||t==="FORM"):!!e&&e.nodeType===Node.ELEMENT_NODE&&(!t||e.tagName.toUpperCase()===t)}var O=["BUTTON","INPUT","OPTGROUP","OPTION","SELECT","TEXTAREA"];function s(e){if(!O.some(r=>i(e,r)))return!0;if(a(e,"disabled"))return!1;if(e.parentNode&&e.parentNode.nodeType===Node.ELEMENT_NODE&&i(e,"OPTGROUP")||i(e,"OPTION"))return s(e.parentNode);let n=e;for(;n;){let r=n.parentNode;if(r&&i(r,"FIELDSET")&&a(r,"disabled")){if(!i(n,"LEGEND"))return!1;let o=n.previousElementSibling;for(;o;){if(i(o,"LEGEND"))return!1;o=o.previousElementSibling}}n=r}return!0}return m(g);})();

try {
  return AtomExport.default.apply(null,arguments);
} catch (e) {
  if (AtomExport.isBotError(e)) {
    throw new Error(JSON.stringify({state: e.state, message: e.message}));
  }
  throw e;
}
}
