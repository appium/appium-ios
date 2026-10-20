function(){var AtomExport=(()=>{var l=Object.defineProperty;var f=Object.getOwnPropertyDescriptor;var E=Object.getOwnPropertyNames;var d=Object.prototype.hasOwnProperty;var N=(e,t)=>{for(var o in t)l(e,o,{get:t[o],enumerable:!0})},m=(e,t,o,i)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of E(t))!d.call(e,n)&&n!==o&&l(e,n,{get:()=>t[n],enumerable:!(i=f(t,n))||i.enumerable});return e};var p=e=>m(l({},"__esModule",{value:!0}),e);var I={};N(I,{default:()=>a,isBotError:()=>u});var T=new WeakSet;function u(e){return typeof e=="object"&&e!==null&&T.has(e)}function c(e,t){return e[t]}function s(e,t){return e instanceof HTMLFormElement?e.nodeType===Node.ELEMENT_NODE&&(!t||t==="FORM"):!!e&&e.nodeType===Node.ELEMENT_NODE&&(!t||e.tagName.toUpperCase()===t)}var g=new Set(["text","search","tel","url","email","password","number"]);function _(e){if(s(e,"TEXTAREA"))return!0;if(s(e,"INPUT")){let t=e.type.toLowerCase();return g.has(t)}return L(e)}function R(e){return s(e,"INPUT")&&e.type.toLowerCase()==="file"}function r(e,t){return s(e,"INPUT")&&e.type.toLowerCase()===t}function L(e){let t=e;if(t.contentEditable===void 0)return!1;if(t.isContentEditable!==void 0)return t.isContentEditable;function o(i){if(i.contentEditable==="inherit"){let n=S(i);return n?o(n):!1}return i.contentEditable==="true"}return o(t)}function a(e){return(_(e)||R(e)||r(e,"range")||r(e,"date")||r(e,"month")||r(e,"week")||r(e,"time")||r(e,"datetime-local")||r(e,"color"))&&!c(e,"readOnly")}function S(e){let t=e.parentNode;for(;t&&t.nodeType!==Node.ELEMENT_NODE&&t.nodeType!==Node.DOCUMENT_NODE&&t.nodeType!==Node.DOCUMENT_FRAGMENT_NODE;)t=t.parentNode;return t&&s(t)?t:null}return p(I);})();

try {
  return AtomExport.default.apply(null,arguments);
} catch (e) {
  if (AtomExport.isBotError(e)) {
    throw new Error(JSON.stringify({state: e.state, message: e.message}));
  }
  throw e;
}
}
