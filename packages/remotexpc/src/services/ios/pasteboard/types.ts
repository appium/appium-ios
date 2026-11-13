import type {XPCDictionary} from '../../../lib/types.js';

export type PasteboardDataInclusionPolicy = XPCDictionary;

export interface PasteboardItem extends XPCDictionary {
  types: string[];
  data: XPCDictionary;
}

export type PasteboardSnapshot = XPCDictionary & {
  items?: PasteboardItem[];
  metadata?: XPCDictionary;
  sourceMetadata?: XPCDictionary;
};

export type PasteboardPullReply = XPCDictionary & {
  command?: string;
  pasteboard?: PasteboardSnapshot;
};
