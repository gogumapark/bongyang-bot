// ════════════════════════════════════════
// 봉양이 — 음악 & TTS 전용 디스코드 봇
// (양봉이와는 완전히 별개의 봇입니다. 토큰/클라이언트ID도 반드시 새로 발급받아 사용하세요)
// ════════════════════════════════════════

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');


const express = require('express');
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    ChannelType,
} = require('discord.js');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const googleTTS = require('google-tts-api');

// ── Render 헬스체크용 최소 웹서버 ──
// (Render의 Web Service는 포트가 열려있어야 정상 동작으로 인식합니다.
//  Background Worker로 배포한다면 이 부분은 없어도 됩니다.)
const app = express();
app.get('/', (req, res) => res.send('봉양이 살아있습니다 🎶'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`헬스체크 서버 실행중: ${PORT}`));

// ── 클라이언트 ──
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // 비워두면 전역 명령어로 등록 (반영까지 최대 1시간)

// ════════════════════════════════════════
// 음악 - DisTube 설정
// ════════════════════════════════════════

const distube = new DisTube(client, {
    plugins: [new YtDlpPlugin()],
    emitNewSongOnly: true,
});

function nowPlayingEmbed(song) {
    return new EmbedBuilder()
        .setTitle('🎵 재생중')
        .setDescription(`[${song.name}](${song.url})`)
        .addFields(
            { name: '⏱ 길이', value: song.formattedDuration || '알 수 없음', inline: true },
            { name: '🙋 요청자', value: song.user ? `${song.user}` : '알 수 없음', inline: true },
        )
        .setThumbnail(song.thumbnail || null)
        .setColor('Purple');
}

distube.on('playSong', (queue, song) => {
    queue.textChannel?.send({ embeds: [nowPlayingEmbed(song)] }).catch(() => {});
});

distube.on('addSong', (queue, song) => {
    queue.textChannel?.send(`➕ 대기열에 추가됨: **${song.name}** (${song.formattedDuration})`).catch(() => {});
});

distube.on('finish', (queue) => {
    queue.textChannel?.send('📭 대기열이 끝났습니다. 봉양이가 노래를 멈춥니다.').catch(() => {});
});

distube.on('empty', (queue) => {
    queue.textChannel?.send('👋 음성 채널에 아무도 없어서 나갑니다.').catch(() => {});
});

distube.on('disconnect', (queue) => {
    queue.textChannel?.send('🔌 음성 채널 연결이 끊어졌습니다.').catch(() => {});
});

distube.on('error', (...args) => {
    console.error('[DisTube 오류]', ...args);
    // DisTube 버전에 따라 이벤트 인자 순서가 다를 수 있어 방어적으로 채널/에러를 찾음
    const channel = args.find((a) => a && typeof a.send === 'function');
    const error = args.find((a) => a instanceof Error);
    if (channel) {
        channel
            .send(`❌ 음악 재생 중 오류가 발생했습니다: ${error?.message || '알 수 없는 오류'}`)
            .catch(() => {});
    }
});

// ════════════════════════════════════════
// TTS - Google TTS (무료, API 키 불필요)
// ════════════════════════════════════════

// google-tts-api URL을 ffmpeg로 스트리밍 디코딩해서 오디오 리소스로 변환
function createTTSResourceFromUrl(url) {
    const ffmpeg = new prism.FFmpeg({
        command: ffmpegPath,
        args: [
            '-i', url,
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
        ],
    });
    return createAudioResource(ffmpeg, { inputType: StreamType.Raw });
}

// 여러 TTS 조각(긴 문장은 자동 분할됨)을 순서대로 재생
function playChunksSequentially(player, urls) {
    return new Promise((resolve) => {
        let index = 0;

        function playNext() {
            if (index >= urls.length) {
                resolve();
                return;
            }
            const resource = createTTSResourceFromUrl(urls[index].url);
            index++;
            player.play(resource);
        }

        player.on(AudioPlayerStatus.Idle, () => {
            playNext();
        });

        playNext();
    });
}

const langMap = {
    ko: '한국어',
    en: '영어',
    ja: '일본어',
};

async function handleTTS(interaction) {
    await interaction.deferReply();

    const text = interaction.options.getString('텍스트');
    const lang = interaction.options.getString('언어') || 'ko';
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
        return interaction.editReply('❌ 먼저 음성 채널에 들어가주세요.');
    }

    if (text.length > 500) {
        return interaction.editReply('❌ 텍스트가 너무 깁니다. 500자 이내로 입력해주세요.');
    }

    const existingQueue = distube.getQueue(interaction.guildId);
    if (existingQueue && existingQueue.playing) {
        return interaction.editReply(
            '❌ 음악 재생 중에는 TTS를 사용할 수 없습니다. 먼저 `/정지` 로 음악을 멈춰주세요.'
        );
    }

    let connection = getVoiceConnection(interaction.guildId);
    let joinedFresh = false;

    try {
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: true,
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 15000);
            joinedFresh = true;
        }

        const urls = await googleTTS.getAllAudioUrls(text, {
            lang,
            slow: false,
            host: 'https://translate.google.com',
        });

        const player = createAudioPlayer();
        connection.subscribe(player);

        await interaction.editReply(`🗣 (${langMap[lang] || lang}) "${text}" 읽는 중...`);

        await playChunksSequentially(player, urls);

        player.stop();

        // 음악용으로 연결된 게 아니라면(=TTS 때문에 새로 들어간 거라면) 다 읽고 나갑니다
        if (joinedFresh && !distube.getQueue(interaction.guildId)) {
            connection.destroy();
        }
    } catch (err) {
        console.error('[TTS 오류]', err);
        if (joinedFresh) {
            try {
                connection?.destroy();
            } catch {}
        }
        return interaction.editReply('❌ TTS 재생 중 오류가 발생했습니다.');
    }
}

// ════════════════════════════════════════
// TTS - 채널 자동 읽기
// ════════════════════════════════════════

const ttsChannels = new Map(); // guildId -> 감시할 텍스트채널 id
const ttsGuildState = new Map(); // guildId -> { queue: [], playing: boolean }

function getTTSGuildState(guildId) {
    if (!ttsGuildState.has(guildId)) {
        ttsGuildState.set(guildId, { queue: [], playing: false });
    }
    return ttsGuildState.get(guildId);
}

async function processTTSQueue(guildId) {
    const state = getTTSGuildState(guildId);
    if (state.playing) return;

    const next = state.queue.shift();
    if (!next) return;

    state.playing = true;

    try {
        // 음악이 재생중이면 오디오가 겹치므로 이번 메시지는 건너뜀
        const musicQueue = distube.getQueue(guildId);
        if (musicQueue && musicQueue.playing) {
            next.message.react('🔇').catch(() => {});
            state.playing = false;
            return processTTSQueue(guildId);
        }

        let connection = getVoiceConnection(guildId);

        if (!connection) {
            if (!next.voiceChannel) {
                // 봇이 아직 음성채널에 없고, 메시지 작성자도 음성채널에 없으면 읽을 수 없음
                state.playing = false;
                return processTTSQueue(guildId);
            }
            connection = joinVoiceChannel({
                channelId: next.voiceChannel.id,
                guildId,
                adapterCreator: next.guild.voiceAdapterCreator,
                selfDeaf: true,
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 15000);
        }

        const urls = await googleTTS.getAllAudioUrls(next.text, {
            lang: 'ko',
            slow: false,
            host: 'https://translate.google.com',
        });

        const player = createAudioPlayer();
        connection.subscribe(player);
        await playChunksSequentially(player, urls);
        player.stop();
    } catch (err) {
        console.error('[TTS 채널 자동읽기 오류]', err);
    }

    state.playing = false;
    processTTSQueue(guildId);
}

function enqueueChannelTTS(message) {
    const state = getTTSGuildState(message.guildId);

    // 너무 많이 쌓이면 오래된 메시지는 버림 (스팸 방지)
    if (state.queue.length >= 10) return;

    let text = message.content.trim();
    if (!text) return;
    if (text.length > 200) text = text.slice(0, 200) + ' (이하 생략)';

    state.queue.push({
        text,
        message,
        guild: message.guild,
        voiceChannel: message.member?.voice?.channel || null,
    });

    processTTSQueue(message.guildId);
}

// ════════════════════════════════════════
// 슬래시 명령어 정의
// ════════════════════════════════════════

const commands = [
    new SlashCommandBuilder()
        .setName('재생')
        .setDescription('노래를 재생하거나 대기열에 추가합니다')
        .addStringOption((option) =>
            option.setName('검색어').setDescription('유튜브 링크 또는 검색어').setRequired(true)
        ),

    new SlashCommandBuilder().setName('정지').setDescription('음악을 정지하고 대기열을 비웁니다'),

    new SlashCommandBuilder().setName('스킵').setDescription('현재 곡을 건너뜁니다'),

    new SlashCommandBuilder().setName('일시정지').setDescription('음악을 일시정지합니다'),

    new SlashCommandBuilder().setName('재개').setDescription('일시정지된 음악을 다시 재생합니다'),

    new SlashCommandBuilder().setName('대기열').setDescription('현재 대기열을 확인합니다'),

    new SlashCommandBuilder().setName('현재곡').setDescription('현재 재생중인 곡 정보를 확인합니다'),

    new SlashCommandBuilder()
        .setName('볼륨')
        .setDescription('음악 볼륨을 조절합니다')
        .addIntegerOption((option) =>
            option.setName('수치').setDescription('0~100').setRequired(true).setMinValue(0).setMaxValue(100)
        ),

    new SlashCommandBuilder()
        .setName('반복')
        .setDescription('반복 모드를 설정합니다')
        .addStringOption((option) =>
            option
                .setName('모드')
                .setDescription('반복 모드 선택')
                .setRequired(true)
                .addChoices(
                    { name: '반복 없음', value: 'off' },
                    { name: '한 곡 반복', value: 'song' },
                    { name: '전체 반복', value: 'queue' }
                )
        ),

    new SlashCommandBuilder().setName('나가기').setDescription('봉양이를 음성 채널에서 내보냅니다'),

    new SlashCommandBuilder()
        .setName('tts')
        .setDescription('입력한 텍스트를 음성으로 읽어줍니다')
        .addStringOption((option) =>
            option.setName('텍스트').setDescription('읽어줄 텍스트 (최대 500자)').setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName('언어')
                .setDescription('읽어줄 언어 (기본: 한국어)')
                .addChoices(
                    { name: '한국어', value: 'ko' },
                    { name: '영어', value: 'en' },
                    { name: '일본어', value: 'ja' }
                )
        ),

    new SlashCommandBuilder()
        .setName('tts채널설정')
        .setDescription('[관리자] 지정한 채널의 메시지를 자동으로 읽어줍니다')
        .addChannelOption((option) =>
            option
                .setName('채널')
                .setDescription('메시지를 자동으로 읽어줄 텍스트 채널')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('tts채널해제')
        .setDescription('[관리자] TTS 자동 읽기를 해제합니다'),

    new SlashCommandBuilder().setName('도움말').setDescription('봉양이의 도움말을 확인합니다'),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('슬래시 명령어 등록중...');
        if (guildId) {
            await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        } else {
            await rest.put(Routes.applicationCommands(clientId), { body: commands });
        }
        console.log('슬래시 명령어 등록 완료!');
    } catch (error) {
        console.error(error);
    }
})();

client.once('clientReady', () => {
    console.log(`${client.user.tag} 로그인 완료!`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        const { commandName } = interaction;

        if (commandName === '도움말') {
            const embed = new EmbedBuilder()
                .setTitle('🐦 봉양이')
                .setDescription('안녕하세요! 음악과 TTS를 담당하는 봉양이입니다.')
                .setColor('Blue')
                .addFields(
                    {
                        name: '🎵 음악',
                        value:
                            '`/재생 검색어:` 노래 재생/대기열 추가\n' +
                            '`/정지` 정지 및 대기열 초기화\n' +
                            '`/스킵` 다음 곡\n' +
                            '`/일시정지` `/재개`\n' +
                            '`/대기열` `/현재곡`\n' +
                            '`/볼륨 수치:` 0~100\n' +
                            '`/반복 모드:` 반복 없음/한곡/전체\n' +
                            '`/나가기` 음성 채널에서 퇴장',
                    },
                    {
                        name: '🗣 TTS',
                        value:
                            '`/tts 텍스트: 언어:` 입력한 텍스트를 그 자리에서 읽어줍니다.\n' +
                            '`/tts채널설정 채널:` [관리자] 지정한 채널의 메시지를 자동으로 읽어줍니다\n' +
                            '`/tts채널해제` [관리자] 자동 읽기 해제\n' +
                            '⚠ 음악 재생 중에는 TTS가 재생되지 않습니다.',
                    }
                );

            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'tts') {
            return handleTTS(interaction);
        }

        if (commandName === 'tts채널설정') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ 관리자만 사용 가능', flags: 64 });
            }
            const channel = interaction.options.getChannel('채널');
            ttsChannels.set(interaction.guildId, channel.id);
            return interaction.reply(
                `🗣 이제부터 ${channel} 채널에 올라오는 메시지를 자동으로 읽어줍니다.\n` +
                `(메시지를 읽으려면 작성자가 음성 채널에 들어가 있어야 하고, 봉양이가 이미 음성 채널에 있다면 그 채널에서 계속 읽습니다)`
            );
        }

        if (commandName === 'tts채널해제') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ 관리자만 사용 가능', flags: 64 });
            }
            ttsChannels.delete(interaction.guildId);
            return interaction.reply('🔇 TTS 자동 읽기를 해제했습니다.');
        }

        // ── 아래부터는 음성 채널 참여가 필요한 음악 명령어 ──
        const voiceChannel = interaction.member.voice.channel;

        if (commandName === '재생') {
            if (!voiceChannel) {
                return interaction.reply({ content: '❌ 먼저 음성 채널에 들어가주세요.', flags: 64 });
            }

            await interaction.deferReply();
            const query = interaction.options.getString('검색어');

            try {
                await distube.play(voiceChannel, query, {
                    member: interaction.member,
                    textChannel: interaction.channel,
                });
                return interaction.editReply(`🔎 "${query}" 요청을 처리했습니다.`);
            } catch (err) {
                console.error(err);
                return interaction.editReply('❌ 재생 중 오류가 발생했습니다. 링크나 검색어를 확인해주세요.');
            }
        }

        const queue = distube.getQueue(interaction.guildId);

        if (commandName === '정지') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            await distube.stop(interaction.guildId);
            return interaction.reply('⏹ 음악을 정지하고 대기열을 비웠습니다.');
        }

        if (commandName === '스킵') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            if (queue.songs.length < 2) {
                return interaction.reply({ content: '❌ 다음 곡이 없습니다.', flags: 64 });
            }
            await queue.skip();
            return interaction.reply('⏭ 다음 곡으로 넘어갑니다.');
        }

        if (commandName === '일시정지') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            queue.pause();
            return interaction.reply('⏸ 일시정지했습니다.');
        }

        if (commandName === '재개') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            queue.resume();
            return interaction.reply('▶ 다시 재생합니다.');
        }

        if (commandName === '대기열') {
            if (!queue || queue.songs.length === 0) {
                return interaction.reply({ content: '❌ 대기열이 비어있습니다.', flags: 64 });
            }
            const list = queue.songs
                .slice(0, 15)
                .map((s, i) => `${i === 0 ? '▶' : `${i}.`} **${s.name}** (${s.formattedDuration})`)
                .join('\n');
            const embed = new EmbedBuilder()
                .setTitle('📋 대기열')
                .setDescription(list + (queue.songs.length > 15 ? `\n...외 ${queue.songs.length - 15}곡` : ''))
                .setColor('Purple');
            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === '현재곡') {
            if (!queue || !queue.songs[0]) {
                return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            }
            return interaction.reply({ embeds: [nowPlayingEmbed(queue.songs[0])] });
        }

        if (commandName === '볼륨') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            const value = interaction.options.getInteger('수치');
            queue.setVolume(value);
            return interaction.reply(`🔊 볼륨을 ${value}로 설정했습니다.`);
        }

        if (commandName === '반복') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            const mode = interaction.options.getString('모드');
            const modeMap = { off: 0, song: 1, queue: 2 };
            queue.setRepeatMode(modeMap[mode]);
            const label = { off: '반복 없음', song: '한 곡 반복', queue: '전체 반복' }[mode];
            return interaction.reply(`🔁 반복 모드: ${label}`);
        }

        if (commandName === '나가기') {
            const connection = getVoiceConnection(interaction.guildId);
            if (!connection) {
                return interaction.reply({ content: '❌ 음성 채널에 있지 않습니다.', flags: 64 });
            }
            if (queue) await distube.stop(interaction.guildId);
            connection.destroy();
            return interaction.reply('👋 음성 채널에서 나갔습니다.');
        }
    } catch (error) {
        console.error(error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply('❌ 오류가 발생했습니다.');
            } else {
                await interaction.reply({ content: '❌ 오류가 발생했습니다.', flags: 64 });
            }
        } catch (e) {
            console.error(e);
        }
    }
});

client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const ttsChannelId = ttsChannels.get(message.guildId);
    if (!ttsChannelId || message.channel.id !== ttsChannelId) return;
    if (message.content.startsWith('/')) return;

    enqueueChannelTTS(message);
});

client.on('error', console.error);
process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

client.login(token);