// The committed IDL matches the program's build (target/idl/loot.json in the program's checkout), and the client knows every instruction in it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as loot from '../client/index.js';
import { program } from './world.mjs';

const built = program ? path.join(program, 'target/idl/loot.json') : '';

test('js/client/idl matches the program build', { skip: built && existsSync(built) ? false : 'no program build (XSOLANA_PROGRAM_DIR)' }, () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/sync-idl.mjs', import.meta.url)), '--check'], { stdio: 'pipe' });
});

test('one builder for every instruction', () => {
  const builders = {
    bid: 'bidIx', buy_tickets: 'buyTicketsIx', callback_lottery: 'callbackLotteryIx', cancel_lottery: 'cancelLotteryIx', finish_lottery_contribution: 'finishLotteryContributionIx',
    callback_random: 'callbackRandomIx', callback_roll: 'callbackRollIx', claim: 'claimIx', claim_grant: 'claimGrantIx',
    collect_fees: 'collectFeesIx', collectible: 'collectibleIx', craft: 'craftIx',
    create_project: 'createProjectIx', buy: 'buyIx', pay_nft: 'payNftIx', decide: 'decideIx', draw_lottery: 'drawLotteryIx', end_auction: 'endAuctionIx', enter: 'enterIx', harvest: 'harvestIx',
    hold: 'holdIx', init_platform: 'initPlatformIx', move_tokens: 'moveTokensIx', open_auction: 'openAuctionIx', open_box: 'openBoxIx',
    open_contest: 'openContestIx', open_farm: 'openFarmIx', open_pool: 'openPoolIx', pay: 'payIx',
    ask_roll: 'askRollIx', close_leaf: 'closeLeafIx', prove_leaf: 'proveLeafIx', prove_traits: 'proveTraitsIx', set_traits: 'setTraitsIx',
    refresh_seat: 'refreshSeatIx', refund: 'refundIx', release: 'releaseIx', roll: 'rollIx',
    run_schedule: 'runScheduleIx', set_platform: 'setPlatformIx', set_suspended: 'setSuspendedIx', settle: 'settleIx', stash: 'stashIx',
    stake_nft: 'stakeNftIx', stake_tokens: 'stakeTokensIx', unstake_nft: 'unstakeNftIx',
    unstake_tokens: 'unstakeTokensIx', update_project: 'updateProjectIx', upsert: 'upsertIx',
    open_tree: 'openTreeIx', open_offer: 'openOfferIx', close_offer: 'closeOfferIx', sell_to_offer: 'sellToOfferIx', borrow: 'borrowIx', repay: 'repayIx',
    open_listing: 'openListingIx', take_listing: 'takeListingIx', close_listing: 'closeListingIx',
  };
  assert.deepEqual(Object.keys(builders).sort(), loot.IDL.instructions.map((i) => i.name).sort());
  for (const fn of Object.values(builders)) assert.equal(typeof loot[fn], 'function', fn);
});
