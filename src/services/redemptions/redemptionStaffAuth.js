import { PermissionFlagsBits } from 'discord.js';
import { REDEMPTION_TICKET_CONFIG } from './ticketConfig.js';

export function getRedemptionStaffAccess(interaction) {
  const config = REDEMPTION_TICKET_CONFIG;

  if (!interaction?.guildId || !interaction?.member) {
    return {
      canClaim: false,
      canManage: false
    };
  }

  const isManager =
    interaction.memberPermissions?.has(
      PermissionFlagsBits.ManageGuild
    ) === true;

  const memberRoles = interaction.member.roles;

  const roleIds = Array.isArray(memberRoles)
    ? memberRoles
    : memberRoles?.cache
      ? [...memberRoles.cache.keys()]
      : [];

  const isStaff = roleIds.some(
    id => config.staffRoleIds.includes(id)
  );

  return {
    canClaim: isStaff || isManager,
    canManage: isManager
  };
}

export function requireRedemptionStaffAccess(
  interaction,
  action
) {
  const access = getRedemptionStaffAccess(interaction);

  const allowed = action === 'claim'
    ? access.canClaim
    : access.canManage;

  if (!allowed) {
    throw new Error(
      'You are not authorized to perform this redemption action.'
    );
  }

  return access;
}
