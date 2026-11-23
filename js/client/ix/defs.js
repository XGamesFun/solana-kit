// Private to ix/ (ix.js does not re-export it): an instruction's IDL entry, its accounts in order, and a piece's. It
// imports no other module here: parts read it as they load (`PIECE`, the accounts of the leaf instructions), which an
// import cycle could leave unset.
import IDL from '../idl/loot.js';

export const instructionDef = name => {
  const def = IDL.instructions.find(i => i.name === name);
  if (!def) throw new Error(`Unknown loot instruction ${name}`);
  return def;
};

/** The accounts of an instruction in order, each with its group (`checkout`, `fee`, `side`, `piece`) or ''. */
export function leaves(list, group = '') {
  return list.flatMap(a => (a.accounts ? leaves(a.accounts, a.name) : [{ ...a, group }]));
}

/** The NFT accounts every route takes as a `Piece`, in the program's order, with the writable flags the IDL has. */
export const PIECE = leaves(instructionDef('hold').accounts).filter(a => a.group === 'piece');
