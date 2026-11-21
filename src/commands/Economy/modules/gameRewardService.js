import { createHash } from 'node:crypto';
import { addLevelXp } from '../../../utils/progression.js';

const RULES = Object.freeze({
  trivia: { coins: 100, xp: 15, cooldownMs: 5 * 60_000 },
  hangman: { coins: 150, xp: 20, cooldownMs: 10 * 60_000 },
  wordle: { coins: 200, xp: 25, cooldownMs: 15 * 60_000 },
  tictactoe: { coins: 75, xp: 10, cooldownMs: 10 * 60_000 },
  fourinarow: { coins: 150, xp: 20, cooldownMs: 15 * 60_000 },
});
const DAY_MINIGAMES = 1500;
const DAY_REPEATABLE = 5000;

function gameRule(game) {
  if (!Object.hasOwn(RULES, game)) throw new Error('Unknown minigame.');
  return RULES[game];
}
function checkId(id) {
  if (typeof id !== 'string' || !/^\d{15,22}$/.test(id)) throw new Error('Invalid Discord ID.');
}
function currentDay() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const find = key => parts.find(p => p.type === key)?.value;
  return `${find('year')}-${find('month')}-${find('day')}`;
}
function opId(game, interactionId) {
  const h = createHash('sha256').update(`cunvrs:${game}:${interactionId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function number(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${label}.`);
  return n;
}

// Read-only preflight: the transaction repeats this check under the account lock.
export async function getGameCooldown(pool, { guildId, userId, game }) {
  checkId(guildId); checkId(userId);
  const rule = gameRule(game);
  const { rows } = await pool.query(
    'SELECT data FROM economy WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  const last = number(rows[0]?.data?.minigameCooldowns?.[game] ?? 0, 'cooldown');
  const nextPlay = last + rule.cooldownMs;
  return { cooldown: last > 0 && Date.now() < nextPlay, nextPlay };
}

// Called ONLY when a game finishes, never for each letter or question.
export async function settleMinigame(pool, { guildId, userId, interactionId, game, won }) {
  checkId(guildId); checkId(userId); checkId(interactionId);
  const rule = gameRule(game);
  if (typeof won !== 'boolean') throw new Error('Invalid game outcome.');
  const db = await pool.connect();
  let begun = false;
  try {
    const schema = await db.query('SELECT MAX(version) AS version FROM schema_migrations');
    if (Number(schema.rows[0]?.version) !== 2) throw new Error('Economy schema v2 required.');
    await db.query('BEGIN'); begun = true;
    await db.query('INSERT INTO guilds (id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
    await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    await db.query(`INSERT INTO economy (guild_id,user_id,balance,bank,data)
      VALUES ($1,$2,0,0,'{"wallet":0,"bank":0,"level":1,"xp":0}'::jsonb)
      ON CONFLICT (guild_id,user_id) DO NOTHING`, [guildId, userId]);
    const locked = await db.query(
      'SELECT balance,data FROM economy WHERE guild_id=$1 AND user_id=$2 FOR UPDATE',
      [guildId,userId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error('Missing account.');
    const data = row.data || {};
    const wallet = number(row.balance, 'balance');
    if (number(data.wallet ?? row.balance, 'wallet') !== wallet) throw new Error('Wallet consistency error.');
    const now = Date.now();
    const cooldowns = data.minigameCooldowns || {};
    const last = number(cooldowns[game] ?? 0, 'cooldown');
    const nextPlay = last + rule.cooldownMs;
    if (last > 0 && now < nextPlay) {
      await db.query('ROLLBACK'); begun = false;
      return { cooldown: true, nextPlay };
    }
    const day = currentDay();
    await db.query(`INSERT INTO cunvrs_economy_daily_limits (guild_id,user_id,local_day)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [guildId,userId,day]);
    const daily = await db.query(`SELECT repeatable_coins,minigame_coins
      FROM cunvrs_economy_daily_limits WHERE guild_id=$1 AND user_id=$2 AND local_day=$3
      FOR UPDATE`, [guildId,userId,day]);
    const repeatable = number(daily.rows[0]?.repeatable_coins,'repeatable total');
    const games = number(daily.rows[0]?.minigame_coins,'minigame total');
    if (repeatable > DAY_REPEATABLE || games > DAY_MINIGAMES || games > repeatable)
      throw new Error('Invalid daily totals.');
    const earned = won ? Math.max(0,Math.min(rule.coins,DAY_MINIGAMES-games,DAY_REPEATABLE-repeatable)) : 0;
    const xpEarned = won && earned > 0 ? rule.xp : 0;
    const progress = addLevelXp(number(data.level ?? 1,'level'),number(data.xp ?? 0,'XP'),xpEarned);
    const after = wallet + earned;
    if (!Number.isSafeInteger(after)) throw new Error('Wallet overflow.');
    const updated = { ...data, wallet:after, level:progress.level, xp:progress.xp,
      minigameCooldowns: {...cooldowns,[game]:now} };
    await db.query(`UPDATE economy SET balance=$3,data=$4::jsonb,updated_at=CURRENT_TIMESTAMP
      WHERE guild_id=$1 AND user_id=$2`, [guildId,userId,after,JSON.stringify(updated)]);
    if (earned > 0) {
      await db.query(`UPDATE cunvrs_economy_daily_limits SET
        repeatable_coins=repeatable_coins+$4,minigame_coins=minigame_coins+$4,
        updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND user_id=$2 AND local_day=$3`,
      [guildId,userId,day,earned]);
      await db.query(`INSERT INTO cunvrs_economy_ledger
        (operation_id,guild_id,user_id,actor_id,event_type,amount,balance_before,balance_after,details)
        VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8::jsonb)`,
        [opId(game,interactionId),guildId,userId,`minigame_${game}`,earned,wallet,after,
          JSON.stringify({won:true})]);
    }
    await db.query('COMMIT'); begun = false;
    return { cooldown:false, won, earned, xpEarned, wallet:after,
      level:progress.level, xp:progress.xp, nextPlay:now+rule.cooldownMs,
      dailyMinigameCoins:games+earned };
  } catch (error) {
    if (begun) await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}
