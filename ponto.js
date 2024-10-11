const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const dailyDataFile = path.join(__dirname, 'dailyData.json');

function loadDailyData() {
    if (fs.existsSync(dailyDataFile)) {
        const rawData = fs.readFileSync(dailyDataFile);
        return new Map(JSON.parse(rawData));
    }
    return new Map();
}

function saveDailyData() {
    fs.writeFileSync(dailyDataFile, JSON.stringify([...dailyData]));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates] });
const pontoData = new Map();
const dailyData = loadDailyData();

const VOICE_CHANNEL_ID = 'ID do canal de voz a ser utilizado';

const commands = [
    new SlashCommandBuilder().setName('ponto').setDescription('Inicia o ponto.'),
    new SlashCommandBuilder().setName('historico').setDescription('Mostra o histórico de tempos por usuário.')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken('BotTOKEN');

(async () => {
    try {
        console.log('Registrando os comandos de slash...');
        await rest.put(Routes.applicationGuildCommands('id do bot', 'id do servidor do discord'), {
            body: commands,
        });
        console.log('Comandos registrados com sucesso!');
    } catch (error) {
        console.error(error);
    }
})();

function formatDuration(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

client.once('ready', () => {
    console.log('Bot está online!');
});

process.on('unhandledRejection', error => {
    console.error('Erro não tratado:', error);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const userId = newState.id;
    const userData = pontoData.get(userId);

    if (userData) {
        if (newState.channelId !== VOICE_CHANNEL_ID) {
            clearInterval(userData.checkInterval);
            const totalDuration = Date.now() - userData.start - userData.pauseDuration;
            const formattedDuration = formatDuration(totalDuration);
            userData.timestamps.push({ type: 'Termino', time: new Date().toLocaleTimeString() });

            dailyData.set(userId, {
                ...(dailyData.get(userId) || {}),
                [new Date().toLocaleDateString()]: (dailyData.get(userId)?.[new Date().toLocaleDateString()] || 0) + totalDuration
            });

            saveDailyData();

            const channel = await client.channels.fetch(userData.channelId);
            if (channel) {
                await channel.send(`Ponto fechado pois o usuário ${newState.member.displayName} não estava conectado ao canal de voz correto.`);
            }

            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle(`Ponto de ${newState.member.displayName}`)
                .addFields(
                    { name: 'Status', value: 'Termino', inline: true },
                    { name: 'Início', value: new Date(userData.start).toLocaleTimeString(), inline: true },
                    { name: 'Duração Total', value: formattedDuration, inline: true },
                    { name: 'Histórico', value: userData.timestamps.map(t => `${t.type}: ${t.time}`).join('\n'), inline: false }
                );

            await channel.send({ embeds: [embed] });
            pontoData.delete(userId);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isCommand() && interaction.commandName === 'historico') {
            await interaction.deferReply({ ephemeral: true });
        
            const embed = new EmbedBuilder()
                .setColor('#0000FF')
                .setTitle('Histórico de Tempos');
        
            for (const [userId, userTime] of dailyData.entries()) {
                try {
                    const guildMember = await interaction.guild.members.fetch(userId);
                    const serverUsername = guildMember.displayName;
                    
                    const userTimeEntries = Object.entries(userTime).map(([date, time]) => {
                        return `${date}: ${formatDuration(time)}`;
                    }).join('\n');
        
                    embed.addFields(
                        { name: `${serverUsername} (ID: ${userId})`, value: userTimeEntries || 'Nenhum tempo registrado', inline: true }
                    );
                } catch (error) {
                    console.error(`Erro ao buscar o usuário ${userId}:`, error);
                }
            }
        
            await interaction.editReply({ embeds: [embed] });
            return;
        }

        if (interaction.isCommand() && interaction.commandName === 'ponto') {
            await interaction.deferReply({ ephemeral: true });
        
            const userId = interaction.user.id;
        
            const member = await interaction.guild.members.fetch(userId);
            const voiceChannel = member.voice.channel;

            if (!voiceChannel || voiceChannel.id !== VOICE_CHANNEL_ID) {
                await interaction.editReply({ content: 'Favor entrar no canal de voz correto para iniciar o ponto.' });
                return;
            }

            if (pontoData.has(userId)) {
                await interaction.editReply({ content: `${interaction.user}, você já iniciou o ponto.` });
                return;
            }
            
            const startTime = Date.now();
            pontoData.set(userId, { 
                start: startTime, 
                pauseDuration: 0, 
                isPaused: false, 
                timestamps: [{ type: 'Início', time: new Date(startTime).toLocaleTimeString() }],
                channelId: interaction.channelId
            });
        
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('pausar')
                        .setLabel('Pausar')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('terminar')
                        .setLabel('Terminar')
                        .setStyle(ButtonStyle.Danger),
                );
        
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle(`Ponto de ${interaction.user.username}`)
                .addFields(
                    { name: 'Status', value: 'Trabalhando', inline: true },
                    { name: 'Início', value: new Date(startTime).toLocaleTimeString(), inline: true },
                    { name: 'Tempo Total', value: '0h 0m 0s', inline: true }
                );
        
            await interaction.editReply({ content: `${interaction.user} iniciou o ponto!`, embeds: [embed], components: [row] });

            const checkInterval = setInterval(async () => {
                const member = await interaction.guild.members.fetch(userId);
                const voiceChannel = member.voice.channel;
            
                console.log(`Verificando usuário ${member.displayName} (${userId}), canal de voz: ${voiceChannel ? voiceChannel.id : 'Nenhum'}`);
            
                if (!voiceChannel || voiceChannel.id !== VOICE_CHANNEL_ID) {
                    clearInterval(checkInterval);
                    pontoData.delete(userId);
            
                    await interaction.followUp({ 
                        content: `Usuário ${member.displayName} (${userId}) foi desconectado por não estar na ligação!`,
                        ephemeral: true
                    });
                }
            }, 1500);
            
            pontoData.get(userId).checkInterval = checkInterval;
            console.log(`Intervalo de checagem definido para o usuário ${userId}`);
    
            return; 
        }
        
        if (interaction.isButton()) {
            if (interaction.replied || interaction.deferred) {
                return;
            }

            await interaction.deferUpdate();

            const userId = interaction.user.id;
            const userData = pontoData.get(userId);

            if (!userData) {
                await interaction.reply({ content: 'Você não tem um ponto ativo.', ephemeral: true });
                return;
            }

            if (interaction.customId === 'pausar') {
                if (userData.isPaused) {
                    await interaction.reply({ content: 'Você já está em pausa.', ephemeral: true });
                    return;
                }
                userData.pauseStart = Date.now();
                userData.isPaused = true;

                userData.timestamps.push({ type: 'Pausa', time: new Date(userData.pauseStart).toLocaleTimeString() });

                const embed = new EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle(`Ponto de ${interaction.user.username}`)
                    .addFields(
                        { name: 'Status', value: 'Pausado', inline: true },
                        { name: 'Início', value: new Date(userData.start).toLocaleTimeString(), inline: true },
                        { name: 'Tempo Total', value: formatDuration(Date.now() - userData.start - userData.pauseDuration), inline: true },
                        { name: 'Histórico', value: userData.timestamps.map(t => `${t.type.replace('Pausa', 'Pausa').replace('Volta', 'Volta')}: ${t.time}`).join('\n'), inline: false }
                    );

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('reabrir')
                            .setLabel('Reabrir')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('terminar')
                            .setLabel('Terminar')
                            .setStyle(ButtonStyle.Danger),
                    );

                await interaction.editReply({ content: `${interaction.user} pausou o ponto.`, embeds: [embed], components: [row] });
                return; 
            }
            
            if (interaction.customId === 'reabrir') {
                if (!userData.isPaused) {
                    await interaction.reply({ content: 'O ponto não está pausado.', ephemeral: true });
                    return;
                }
            
                const pauseDuration = Date.now() - userData.pauseStart;
                userData.pauseDuration += pauseDuration;
                userData.isPaused = false;
            
                userData.timestamps.push({ type: 'Volta', time: new Date(Date.now()).toLocaleTimeString() });
            
                const embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle(`Ponto de ${interaction.user.username}`)
                    .addFields(
                        { name: 'Status', value: 'Trabalhando', inline: true },
                        { name: 'Início', value: new Date(userData.start).toLocaleTimeString(), inline: true },
                        { name: 'Tempo Total', value: formatDuration(Date.now() - userData.start - userData.pauseDuration), inline: true },
                        { name: 'Histórico', value: userData.timestamps.map(t => `${t.type}: ${t.time}`).join('\n'), inline: false }
                    );

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('pausar')
                            .setLabel('Pausar')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('terminar')
                            .setLabel('Terminar')
                            .setStyle(ButtonStyle.Danger),
                    );

                await interaction.editReply({ content: `${interaction.user} reabriu o ponto.`, embeds: [embed], components: [row] });
                return;
            }

            if (interaction.customId === 'terminar') {
                clearInterval(userData.checkInterval);
                const totalDuration = Date.now() - userData.start - userData.pauseDuration;
                const formattedDuration = formatDuration(totalDuration);
                userData.timestamps.push({ type: 'Termino', time: new Date().toLocaleTimeString() });
            
                dailyData.set(userId, {
                    ...(dailyData.get(userId) || {}),
                    [new Date().toLocaleDateString()]: (dailyData.get(userId)?.[new Date().toLocaleDateString()] || 0) + totalDuration
                });

                saveDailyData()
            
                const embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle(`Ponto de ${interaction.user.username}`)
                    .addFields(
                        { name: 'Status', value: 'Termino', inline: true },
                        { name: 'Início', value: new Date(userData.start).toLocaleTimeString(), inline: true },
                        { name: 'Duração Total', value: formattedDuration, inline: true },
                        { name: 'Histórico', value: userData.timestamps.map(t => `${t.type}: ${t.time}`).join('\n'), inline: false }
                    );
            
                await interaction.editReply({ content: `${interaction.user} terminou o ponto. Duração total: ${formattedDuration}.`, embeds: [embed], components: [] });
                pontoData.delete(userId);
            }
        }
    } catch (error) {
        console.error('Erro na interação:', error);
    }
});

client.login('BotTOKEN');
