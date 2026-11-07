const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Explore all available commands by category.'),

    async execute(interaction) {

        //--------------------------
        // STATIC CATEGORY MAP
        //--------------------------
        const categories = {

            '🏁 Racing & League': [
                '**`/register`** — Register yourself to the racing league database.',
                '**`/results`** — Post race results, update statistics, and distribute coins.',
                '**`/driversfix`** — Edit driver stats manually.',
                '**`/race-set`** — Manually start a race countdown timer.',
                '**`/race-delay`** — Delay an active race timer.',
                '**`/race-guess`** — Predict the race winner before results drop.',
                '**`/racetime`** — Convert race time (6 PM PKT) to any local timezone.',
                '**`/track`** — Get detailed info about any motorsport circuit.',
                '**`/rating`** — View a driver\'s Mad+ Rating and history.',
                '**`/leaderboard`** — View driver rankings based on overall rating.',
        '**`/carss`** — Find the screenshot message for a car ID.',
                '**`/wr`** — Sync or show world records for a track (`sync`, `show`).',
                '**`/stats`** — Show racing statistics for yourself or another driver.',
                '**`/vs`** — Compare two drivers head to head.',
            ],

            '💰 Economy': [
                '**`/wallet`** — Check your coin balance and economy stats.',
                '**`/coinboard`** — See the richest 10 drivers on the server.',
                '**`/shop`** — Browse and purchase items from the OM Economy Shop.',
                '**`/sponsor`** — View sponsor offers and sign deals for coins.',
                '**`/pay`** — Send coins to another driver.',
                '**`/give-coins`** — *(Admin)* Add, remove, or set coins for a driver.',
            ],

            '🎰 Casino': [
                '**`/blackjack`** — Play a hand of blackjack against the dealer.',
                '**`/slots`** — Spin the OM slot machine.',
                '**`/coinflip`** — Flip a coin — double or nothing.',
                '**`/dice`** — Roll dice against the house. Highest roll wins.',
                '**`/roulette`** — Spin the European roulette wheel.',
                '**`/crash`** — Bet on the crash multiplier before it collapses.',
                '**`/highlow`** — Guess if the next card is Higher or Lower. Chain correct guesses for bigger multipliers!',
                '**`/mines`** — Reveal safe squares on a minefield grid. Hit a mine and lose it all.',
                '**`/plinko`** — Drop the ball and watch it bounce into a multiplier bucket. (Low / Mid / High risk)',
                '**`/poker`** — Multiplayer Texas Hold\'em Poker! 2-6 players, buy-in, DM hole cards.',
                '**`/bet`** — Open or join a race betting pool.',
            ],

            '📊 Stats & Votes': [
                '**`/dots`** — Vote for the Driver of the Season (DOTS).',
                '**`/tots`** — Vote for the Team of the Season (TOTS).',
                '**`/dotyvote`** — *(Admin)* Start a DOTY vote between selected drivers.',
                '**`/vote`** — Start an advanced custom poll.',
                '**`/vote-remove`** — Delete a poll message by its ID.',
                '**`/report`** — Report a user to the staff team.',
            ],

            '🛡️ Raid Protection': [
                '**`/antiraid on`** — Enable Chamy\'s raid protection in this server.',
                '**`/antiraid off`** — Disable raid protection.',
                '**`/antiraid status`** — Show current settings and missing permissions.',
                '**`/antiraid snapshot`** — Save the server structure now (for nuke restore).',
                '**`/antiraid restore`** — Restore channels/roles from the latest snapshot.',
                '**`/antiraid unlock`** — End an active raid lockdown early.',
                '**`/antiraid alertchannel`** — Set where raid alerts are posted.',
                '**`/antiraid whitelist`** — Exempt a user or role from all raid actions.',
                '**`/antiraid sensitivity`** — Tune join-raid and nuke thresholds.',
                '**`/antiraid tonescan`** — Toggle the daily AI scan for raid recon / harassment.',
                '**`/antiraid trust`** — Show a member\'s trust score and breakdown.',
                '**`/verify`** — Set up the captcha verification gate in this channel.',
            ],

            '🛠️ Moderation': [
                '**`/ban`** — Ban a member from the server.',
                '**`/unban`** — Unban a user by their ID.',
                '**`/kick`** — Kick a member from the server.',
                '**`/mute`** — Mute a member using Discord timeout.',
                '**`/unmute`** — Remove timeout from a member.',
                '**`/to`** — Quick 10-minute timeout for a member.',
                '**`/unto`** — Quickly remove a timeout from a member.',
                '**`/warn`** — Issue a warning to a member.',
                '**`/warnings`** — View all active warnings for a member.',
                '**`/clear-warning`** — Clear all warnings for a member.',
                '**`/purge`** — Bulk-delete recent messages in a channel.',
                '**`/quarantina`** / **`/unquarantina`** — Quarantine/release a user (restrict to jail channel).',
                '**`/setupjail`** — Apply the full jail system to the server.',
                '**`/lockchannel`** — Lock a channel from all non-staff roles.',
                '**`/unlockchannel`** — Unlock a channel and reset role restrictions.',
                '**`/slowmode`** — Set a channel slowmode/ratelimit (in seconds).',
                '**`/nick`** — Change a member\'s nickname.',
                '**`/addrole`** — Create a new role in the server.',
                '**`/delrole`** — Delete an existing role from the server.',
                '**`/editrole`** — Rename an existing role.',
                '**`/give-role`** — Assign a role to a member.',
                '**`/take-role`** — Remove a role from a member.',
                '**`/dm`** — Send a direct message to a user as the bot.',
                '**`/teamradio`** — Toggle FIA team radio access for the server.',
            ],

            '🎮 Mini-Games': [
                '**`/dragrace`** — 🏎️ Drag Race — Mash the button and cross the finish line first!',
                '**`/redlights`** — 🔴 5 Red Lights — F1 start reaction race.',
                '**`/caption`** — 📝 Caption This! — Write the funniest caption and let the server vote.',
                '**`/chaoscall`** — 🎲 Draw a random Chaos Call for the mid-season.',
                '**`/gartic`** — 🎨 Gartic — Describe a word using ONLY emojis, others guess!',
                '**`/hangman`** — 🪓 Hangman — Guess the word before time runs out.',
                '**`/hungergames`** — ⚔️ Hunger Games — Enter as tributes, watch the story unfold.',
                '**`/interview`** — 🎙️ Anonymous driver interview — answer questions from the grid.',
                '**`/jenga`** — 🧱 Jenga — Pull blocks without toppling the tower. (2-8 players)',
                '**`/keeptalking`** — 💣 Keep Talking — Co-op bomb defusal. One defuser, the rest are experts.',
                '**`/millionaire`** — 💰 Who Wants to Be a Millionaire? — Team voting, lifelines, 15 questions.',
                '**`/monopoly`** — 🏁 OM Monopoly — Buy circuits, collect rent, bankrupt your rivals. (2-6 players)',
                '**`/numguess`** — 🔢 Number Guess Battle — Guess closest to win!',
                '**`/trivia`** — 🧠 F1 Trivia Quiz — Test your motorsport knowledge.',
                '**`/whosaidit`** — 🕵️ Who Said It? — Guess who wrote the server message.',
                '**`/feign`** — 🎭 Feign — Social deduction game! Find the impostor. (3-8 players)',
            ],

            '⚙️ System & Utility': [
                '**`/help`** — Display this command guide.',
                '**`/ping`** — Check the bot\'s current latency.',
                '**`/config`** — *(Admin)* Configure per-server channels, roles and staff.',
                '**`/maintenance`** — *(Admin)* Toggle bot maintenance mode.',
                '**`/setprefix`** — *(Admin)* Change the bot prefix for this server.',
            ],
        };

        //--------------------------
        // UI COMPONENTS
        //--------------------------
        const options = Object.keys(categories).map(cat => ({
            label: cat.split(' ').slice(1).join(' '),
            value: cat,
            emoji: cat.split(' ')[0],
            description: `View commands for ${cat.split(' ').slice(1).join(' ')}.`
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('help_menu')
            .setPlaceholder('Select a category...')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const mainEmbed = new EmbedBuilder()
            .setColor(0x00D2FF)
            .setTitle('Chamy | Help Center')
            .setDescription(
                "Welcome to the command manual. Select a category from the menu below to explore all available tools — racing, economy, raid protection, moderation and more."
            )
            .addFields(
                { name: '📁 Categories', value: Object.keys(categories).join('\n'), inline: true },
                { name: 'System Status', value: '🟢 All systems operational', inline: true }
            )
            .setFooter({ text: 'Chamy | System Manual' })
            .setTimestamp();

        const response = await interaction.reply({ embeds: [mainEmbed], components: [row] });

        //--------------------------
        // COLLECTOR
        //--------------------------
        const collector = response.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 120000
        });

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: "Please use /help to open your own menu.", ephemeral: true });
            }

            const selected = i.values[0];
            const cmdList = categories[selected].join('\n');

            const categoryEmbed = new EmbedBuilder()
                .setColor(0x2f3136)
                .setTitle(`${selected}`)
                .setDescription(cmdList)
                .setFooter({ text: 'Chamy | Use /command to get started' })
                .setTimestamp();

            await i.update({ embeds: [categoryEmbed] });
        });

        collector.on('end', () => {
            const disabledRow = new ActionRowBuilder().addComponents(selectMenu.setDisabled(true));
            interaction.editReply({ components: [disabledRow] }).catch(() => {});
        });
    }
};
