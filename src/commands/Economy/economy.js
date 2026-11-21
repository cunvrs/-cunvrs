
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';

import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import economyDashboard from './modules/economy_dashboard.js';

import {
    QUESTS,
    getQuestStatus,
    claimQuest,
} from './modules/questService.js';

import { UNICOIN_EMOJI } from '../../utils/wallet.js';
import {
    handleRedemptionSubcommand,
    redemptionRewardChoices,
} from '../../services/redemptions/discordRedemptions.js';

const PINK = 0xFFEDF4;

function questEmbed(description) {
    return new EmbedBuilder()
        .setColor(PINK)
        .setDescription(description)
        .setFooter({
            text: 'cunvrs. • daily quests reset at midnight Detroit time',
        });
}

export default {
    slashOnly: true,

    data: new SlashCommandBuilder()
        .setName('economy')
        .setDescription('Economy dashboard and daily quests')
        .setDMPermission(false)

        // Dashboard remains staff-only through an
        // explicit permission check in execute().
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the economy management dashboard')
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName('quests')
                .setDescription('View your daily Unicoin quests')
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName('claim')
                .setDescription('Claim a completed daily quest')
                .addStringOption(option =>
                    option
                        .setName('quest')
                        .setDescription('Choose the quest reward to claim')
                        .setRequired(true)
                        .addChoices(
                            ...Object.entries(QUESTS).map(([id, quest]) => ({
                                name: quest.name,
                                value: id,
                            }))
                        )
                )
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName('verifyticket')
                .setDescription('Verify a Ticketcord redemption ticket owner')
                .addUserOption(option =>
                    option
                        .setName('member')
                        .setDescription('The verified ticket owner')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('confirmation')
                        .setDescription('Enter VERIFY after checking ownership')
                        .setRequired(true)
                )
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName('redeem')
                .setDescription('Redeem Unicoins inside your verified ticket')
                .addStringOption(option =>
                    option
                        .setName('reward')
                        .setDescription('Choose your reward')
                        .setRequired(true)
                        .addChoices(...redemptionRewardChoices)
                )
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName('redemptions')
                .setDescription('View redemption requests in this ticket')
        )

        .addSubcommand(subcommand =>
            subcommand
                .setName('manage')
                .setDescription('Manage a redemption request')
                .addStringOption(option =>
                    option
                        .setName('request')
                        .setDescription('Redemption request UUID')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('action')
                        .setDescription('Staff action')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Approve', value: 'approve' },
                            { name: 'Decline and refund', value: 'decline' },
                            { name: 'Mark delivered', value: 'deliver' }
                        )
                )
                .addStringOption(option =>
                    option
                        .setName('evidence')
                        .setDescription('Delivery reference, required for Deliver')
                        .setRequired(false)
                )
        ),

    category: 'Economy',

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(
            interaction,
            { flags: MessageFlags.Ephemeral }
        );

        if (!deferred) return;


        const subcommand = interaction.options.getSubcommand();

        if ([
            'verifyticket',
            'redeem',
            'redemptions',
            'manage',
        ].includes(subcommand)) {
            return await handleRedemptionSubcommand(interaction);
        }

        // Keep the existing management dashboard restricted.
        if (subcommand === 'dashboard') {
            const isManager = interaction.memberPermissions?.has(
                PermissionFlagsBits.ManageGuild
            );

            if (!isManager) {
                return await interaction.editReply({
                    content: '♡ only server managers can access the economy dashboard!',
                });
            }

            return await economyDashboard.execute(
                interaction,
                config,
                client
            );
        }

        if (!interaction.guildId) {
            return await interaction.editReply({
                content: '♡ daily quests are only available inside servers!',
            });
        }

        try {
            const guildId = interaction.guildId;
            const userId = interaction.user.id;

            if (subcommand === 'quests') {
                const status = await getQuestStatus(
                    guildId,
                    userId
                );

                const description = status.quests.map(quest => {
                    let progressText;

                    if (quest.claimed) {
                        progressText = '♡ **reward claimed!**';
                    } else if (quest.completed) {
                        progressText = '♡ **ready to claim!**';
                    } else {
                        progressText =
                            `♡ **progress:** ${quest.progress}/${quest.goal}`;
                    }

                    return (
                        `**${quest.name}**\n` +
                        `${quest.description}\n` +
                        `${progressText}\n` +
                        `${UNICOIN_EMOJI} **reward:** ${quest.reward.toLocaleString()}`
                    );
                }).join('\n\n');

                return await interaction.editReply({
                    embeds: [
                        questEmbed(
                            `## 🎀 ⋮ **__daily quests!__**\n\n` +
                            `${description}\n\n` +
                            '♡ use `/economy claim` when a quest is complete!'
                        ),
                    ],
                });
            }

            if (subcommand === 'claim') {
                const questId = interaction.options.getString(
                    'quest',
                    true
                );

                const result = await claimQuest(
                    guildId,
                    userId,
                    questId
                );

                if (!result.success) {
                    return await interaction.editReply({
                        embeds: [
                            questEmbed(
                                `## 🎀 ⋮ **__daily quests!__**\n\n` +
                                `♡ ${result.message}`
                            ),
                        ],
                    });
                }

                return await interaction.editReply({
                    embeds: [
                        questEmbed(
                            `## 🎀 ⋮ **__quest completed!__**\n\n` +
                            `♡ **quest:** ${result.quest}\n` +
                            `${UNICOIN_EMOJI} **earned:** +${result.earned.toLocaleString()}\n` +
                            `${UNICOIN_EMOJI} **wallet:** ${result.wallet.toLocaleString()}\n\n` +
                            '♡ congratulations on completing your quest!'
                        ),
                    ],
                });
            }

            return await interaction.editReply({
                content: '♡ unknown economy command!',
            });

        } catch (error) {
            logger.error('Economy quest error:', error);

            return await interaction.editReply({
                embeds: [
                    questEmbed(
                        '♡ something went wrong while loading your quests. ' +
                        'please try again later!'
                    ),
                ],
            });
        }
    },
};
