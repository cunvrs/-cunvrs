
export const MAX_IQ = 250;
export const COLLEGE_REQUIRED_IQ = 100;
export const STUDY_COOLDOWN = 4 * 60 * 60 * 1000;
export const STUDY_XP = 25;

export function xpNeededForLevel(level) {
  if (!Number.isSafeInteger(level) || level < 1) {
    throw new Error('Invalid economy level.');
  }

  return level * 100;
}

export function totalXpToReachLevel(level) {
  if (!Number.isSafeInteger(level) || level < 1) {
    throw new Error('Invalid economy level.');
  }

  return 50 * level * (level - 1);
}

export function addLevelXp(currentLevel, currentXp, earnedXp) {
  if (
    !Number.isSafeInteger(currentLevel) ||
    currentLevel < 1 ||
    !Number.isSafeInteger(currentXp) ||
    currentXp < 0 ||
    !Number.isSafeInteger(earnedXp) ||
    earnedXp < 0
  ) {
    throw new Error('Invalid level or XP value.');
  }

  let level = currentLevel;
  let xp = currentXp + earnedXp;

  if (!Number.isSafeInteger(xp)) {
    throw new Error('XP exceeds supported limits.');
  }

  const previousLevel = level;

  while (xp >= xpNeededForLevel(level)) {
    xp -= xpNeededForLevel(level);
    level++;
  }

  return {
    level,
    xp,
    levelsGained: level - previousLevel,
    xpToNextLevel: xpNeededForLevel(level),
  };
}

export function addIq(currentIq, gainedIq) {
  if (
    !Number.isSafeInteger(currentIq) ||
    !Number.isSafeInteger(gainedIq) ||
    gainedIq < 0
  ) {
    throw new Error('Invalid IQ value.');
  }

  return Math.min(
    MAX_IQ,
    Math.max(0, currentIq + gainedIq)
  );
}

export function getIqWorkBonus(iq, graduated = false) {
  if (!Number.isSafeInteger(iq)) {
    throw new Error('Invalid IQ value.');
  }

  const score = Math.max(0, Math.min(MAX_IQ, iq));

  if (!graduated) {
    return Math.min(0.09, Math.floor(score / 10) * 0.01);
  }

  return Math.min(
    0.30,
    0.15 + Math.floor(Math.max(0, score - 100) / 10) * 0.01
  );
}
