// ════════════════════════════════════════
// 봉양이 — 음악 & TTS 전용 디스코드 봇 (재작성판 v2)
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
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');
const { DisTube } = require('distube');
const { json: ytdlpJson } = require('@distube/yt-dlp');

// 검색어를 실제 유튜브 URL로 변환 (DisTube 내장 검색기는 유튜브 차단으로 자주 실패하므로 yt-dlp로 직접 검색)
async function resolveToUrl(query) {
    const isUrl = /^https?:\/\//i.test(query);
    if (isUrl) return query;

    const info = await ytdlpJson(`ytsearch1:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        preferFreeFormats: true,
        skipDownload: true,
        simulate: true,
    });

    const entry = info.entries?.[0] || info;
    if (!entry || !(entry.webpage_url || entry.url)) {
        throw new Error(`"${query}"에 대한 검색 결과를 찾을 수 없습니다.`);
    }
    return entry.webpage_url || entry.url;
}
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
    generateDependencyReport,
} = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const { Readable } = require('stream');

// ── 시작 시 의존성 상태 출력 (문제 생기면 바로 원인 파악 가능) ──
console.log(generateDependencyReport());
console.log('[정보] ffmpeg 경로:', ffmpegPath);

// ── 헬스체크용 최소 웹서버 (렌더 등에서 필요, 오라클/로컬에선 무해) ──
const app = express();
app.get('/', (req, res) => res.send('봉양이 살아있습니다 🎶'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[정보] 헬스체크 서버 실행중: ${PORT}`));

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
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
    console.error('[치명적 오류] TOKEN 또는 CLIENT_ID 환경변수가 설정되지 않았습니다.');
    process.exit(1);
}

// ════════════════════════════════════════
// 음성 연결 헬퍼 (상세 로깅 포함)
// ════════════════════════════════════════

/**
 * 음성 채널에 연결하고, 상태 변화를 전부 로깅하며, Ready 상태까지 기다립니다.
 * @param {import('discord.js').VoiceBasedChannel} voiceChannel
 * @param {number} timeoutMs
 * @returns {Promise<import('@discordjs/voice').VoiceConnection>}
 */
async function connectToVoiceChannel(voiceChannel, timeoutMs = 30000) {
    const guildId = voiceChannel.guild.id;
    console.log(`[음성] [${guildId}] 연결 시도: 채널=${voiceChannel.name} (${voiceChannel.id})`);

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
        debug: true,
    });

    connection.on('stateChange', (oldState, newState) => {
        console.log(`[음성상태] [${guildId}] ${oldState.status} → ${newState.status}`);
        if (newState.status === VoiceConnectionStatus.Disconnected) {
            // 연결이 예기치 않게 끊긴 경우 상세 정보 출력
            console.log(`[음성상태 상세] [${guildId}]`, JSON.stringify(newState, null, 2));
        }
    });

    connection.on('error', (err) => {
        console.error(`[음성 에러] [${guildId}]`, err);
    });

    // 내부 네트워킹 상태도 로깅 (UDP/WebSocket 핸드셰이크 단계 확인용)
    connection.on('debug', (msg) => {
        console.log(`[음성 디버그] [${guildId}] ${msg}`);
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
        console.log(`[음성] [${guildId}] 연결 성공! (Ready 상태 진입)`);
        return connection;
    } catch (err) {
        console.error(`[음성] [${guildId}] 연결 실패 (${timeoutMs}ms 내 Ready 상태 미도달):`, err.message);
        console.error(`[음성] [${guildId}] 현재 connection.state:`, JSON.stringify(connection.state, null, 2));
        try {
            connection.destroy();
        } catch (destroyErr) {
            console.error('[음성] 연결 정리 중 추가 오류:', destroyErr);
        }
        throw err;
    }
}

// ════════════════════════════════════════
// 음악 - DisTube 설정
// ════════════════════════════════════════

const distube = new DisTube(client, {
    plugins: [new YtDlpPlugin({ update: false })],
    emitNewSongOnly: true,
    ffmpeg: {
        path: ffmpegPath,
    },
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
    musicSwitchWarned.delete(queue.id);
});

distube.on('empty', (queue) => {
    queue.textChannel?.send('👋 음성 채널에 아무도 없어서 나갑니다.').catch(() => {});
    musicSwitchWarned.delete(queue.id);
});

distube.on('disconnect', (queue) => {
    queue.textChannel?.send('🔌 음성 채널 연결이 끊어졌습니다.').catch(() => {});
    musicSwitchWarned.delete(queue.id);
});

distube.on('error', (...args) => {
    console.error('[DisTube 오류]', ...args);
    const channel = args.find((a) => a && typeof a.send === 'function');
    const error = args.find((a) => a instanceof Error);
    console.error('[DisTube 오류 상세]', error?.stack || error);
    if (channel) {
        channel
            .send(`❌ 음악 재생 중 오류가 발생했습니다: ${error?.message || '알 수 없는 오류'}`)
            .catch(() => {});
    }
});

distube.on('debug', (msg) => {
    console.log('[DisTube 디버그]', msg);
});

// ════════════════════════════════════════
// TTS - ElevenLabs
// ════════════════════════════════════════

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!ELEVENLABS_API_KEY) {
    console.warn('[경고] ELEVENLABS_API_KEY 환경변수가 설정되지 않았습니다. TTS 기능이 작동하지 않습니다.');
}

// ElevenLabs 계정에 등록된 목소리 목록을 가져와 캐싱 (자동완성에 사용)
let voicesCache = [];
const DEFAULT_VOICE_ID_FALLBACK = '21m00Tcm4TlvDq8ikWAM'; // Rachel (혹시 캐시가 비어있을 때 사용)

// 유저가 /보이스설정 에서 고를 수 있는 고정 목소리 4종
const PRESET_VOICES = [
    { id: 'Dyrk0BXUrEfP36mgXeJD', name: '여성 1 - 활발한 목소리' },
    { id: 'Y3UKelKJZyjkuNLnYsLm', name: '여성 2 - 나레이터 목소리' },
    { id: 'ZJ7CnFUgK4JZnvPqF4mL', name: '남성 1 - 차분한 목소리' },
    { id: '1KNqBv4TutQtzSIACsMC', name: '남성 2 - AI영상 나레이터 목소리' },
];

const userVoicePref = new Map(); // userId -> voiceId (유저별 선택 목소리)
const musicSwitchWarned = new Set(); // 이미 "노래 재생 중" 경고를 보낸 길드 (스팸 방지)
const pendingPlayRequests = new Map(); // requestId -> { voiceChannel, rawQuery, textChannel, member }

async function refreshVoicesCache() {
    if (!ELEVENLABS_API_KEY) return;
    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY },
        });
        if (!response.ok) throw new Error(`목소리 목록 조회 실패 (${response.status})`);
        const data = await response.json();
        voicesCache = (data.voices || []).map((v) => ({ name: v.name, id: v.voice_id }));
        console.log(`[ElevenLabs] 목소리 ${voicesCache.length}개 로드 완료`);
    } catch (err) {
        console.error('[ElevenLabs] 목소리 목록 조회 오류:', err.message);
    }
}

async function synthesizeSpeech(text, voiceId) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`ElevenLabs API 오류 (${response.status}): ${errText.slice(0, 200)}`);
    }

    return Readable.fromWeb(response.body);
}

function createResourceFromMp3Stream(mp3Stream) {
    const ffmpeg = new prism.FFmpeg({
        command: ffmpegPath,
        args: [
            '-i', 'pipe:0',
            '-analyzeduration', '0',
            '-loglevel', 'warning',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
        ],
    });

    ffmpeg.process.stderr.on('data', (data) => {
        console.log('[ffmpeg stderr]', data.toString());
    });

    mp3Stream.pipe(ffmpeg);
    return createAudioResource(ffmpeg, { inputType: StreamType.Raw });
}

function playOnce(player, resource) {
    return new Promise((resolve, reject) => {
        player.play(resource);
        player.once(AudioPlayerStatus.Idle, resolve);
        player.once('error', reject);
    });
}

// ════════════════════════════════════════
// TTS - 채널 자동 읽기
// ════════════════════════════════════════

const ttsChannels = new Map();
const ttsChannelVoice = new Map(); // guildId -> 선택된 voiceId
const ttsGuildState = new Map();

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
        const musicQueue = distube.getQueue(guildId);
        if (musicQueue && musicQueue.playing) {
            if (!musicSwitchWarned.has(guildId)) {
                musicSwitchWarned.add(guildId);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`switch_to_tts:${guildId}`)
                        .setLabel('🔄 노래 정지하고 TTS로 전환')
                        .setStyle(ButtonStyle.Danger)
                );
                next.message.channel
                    .send({ content: '⚠️ 지금 노래가 재생 중이라 TTS를 읽을 수 없어요. 전환할까요?', components: [row] })
                    .catch(() => {});
            }
            next.message.react('🔇').catch(() => {});
            state.playing = false;
            return processTTSQueue(guildId);
        }

        let connection = getVoiceConnection(guildId);

        if (connection && connection.state.status !== VoiceConnectionStatus.Ready) {
            try { connection.destroy(); } catch {}
            connection = null;
        }

        if (!connection) {
            if (!next.voiceChannel) {
                state.playing = false;
                return processTTSQueue(guildId);
            }
            connection = await connectToVoiceChannel(next.voiceChannel, 30000);
        }

        const chosenVoiceId =
            userVoicePref.get(next.message.author.id) ||
            ttsChannelVoice.get(guildId) ||
            voicesCache[0]?.id ||
            DEFAULT_VOICE_ID_FALLBACK;
        const mp3Stream = await synthesizeSpeech(next.text, chosenVoiceId);
        const resource = createResourceFromMp3Stream(mp3Stream);

        const player = createAudioPlayer();
        connection.subscribe(player);
        await playOnce(player, resource);
        player.stop();
    } catch (err) {
        console.error('[TTS 채널 자동읽기 오류]', err);
    }

    state.playing = false;
    processTTSQueue(guildId);
}

function enqueueChannelTTS(message) {
    const state = getTTSGuildState(message.guildId);

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
        .setName('tts채널설정')
        .setDescription('[관리자] 지정한 채널의 메시지를 자동으로 읽어줍니다')
        .addChannelOption((option) =>
            option
                .setName('채널')
                .setDescription('메시지를 자동으로 읽어줄 텍스트 채널')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName('목소리')
                .setDescription('자동읽기에 사용할 목소리 (입력하면 자동완성, 생략 시 기본값)')
                .setAutocomplete(true)
        ),

    new SlashCommandBuilder()
        .setName('tts채널해제')
        .setDescription('[관리자] TTS 자동 읽기를 해제합니다'),

    new SlashCommandBuilder().setName('도움말').setDescription('봉양이의 도움말을 확인합니다'),

    new SlashCommandBuilder().setName('보이스설정').setDescription('TTS에서 사용할 내 목소리를 선택합니다'),

    // 진단용 명령어 (문제 생기면 바로 확인 가능)
    new SlashCommandBuilder().setName('진단').setDescription('[관리자] 봇의 음성 연결 상태를 진단합니다'),
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
        console.error('[명령어 등록 오류]', error);
    }
})();

client.once('clientReady', () => {
    console.log(`${client.user.tag} 로그인 완료!`);
    refreshVoicesCache();
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'tts채널설정') {
            const focused = interaction.options.getFocused().toLowerCase();
            const filtered = voicesCache
                .filter((v) => v.name.toLowerCase().includes(focused))
                .slice(0, 25)
                .map((v) => ({ name: v.name, value: v.id }));
            try {
                await interaction.respond(filtered);
            } catch (err) {
                console.error('[자동완성 오류]', err);
            }
        }
        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_voice') {
            const voiceId = interaction.values[0];
            userVoicePref.set(interaction.user.id, voiceId);
            const label = PRESET_VOICES.find((v) => v.id === voiceId)?.name || voiceId;
            return interaction.update({ content: `✅ 목소리가 "${label}" (으)로 설정되었습니다!`, components: [] });
        }
        return;
    }

    if (interaction.isButton()) {
        const [action, payload] = interaction.customId.split(':');

        if (action === 'switch_to_tts') {
            const targetGuildId = payload;
            try {
                const musicQueue = distube.getQueue(targetGuildId);
                if (musicQueue) await distube.stop(targetGuildId).catch(() => {});
                musicSwitchWarned.delete(targetGuildId);
                await interaction.update({
                    content: '✅ 노래를 정지했습니다. 다음 메시지부터 TTS로 읽어드릴게요.',
                    components: [],
                });
            } catch (err) {
                console.error('[전환 오류: TTS]', err);
                await interaction.update({ content: '❌ 전환 중 오류가 발생했습니다.', components: [] }).catch(() => {});
            }
            return;
        }

        if (action === 'switch_to_music') {
            const requestId = payload;
            const req = pendingPlayRequests.get(requestId);
            if (!req) {
                return interaction.update({ content: '❌ 요청이 만료되었습니다. 다시 `/재생`을 시도해주세요.', components: [] });
            }
            pendingPlayRequests.delete(requestId);

            const conn = getVoiceConnection(interaction.guildId);
            if (conn) {
                try { conn.destroy(); } catch (err) { console.error('[전환] 기존 연결 정리 오류:', err); }
            }

            await interaction.update({ content: '🔄 TTS를 정지하고 노래를 재생합니다...', components: [] });

            try {
                const url = await resolveToUrl(req.rawQuery);
                await distube.play(req.voiceChannel, url, {
                    member: req.member,
                    textChannel: req.textChannel,
                });
                await interaction.followUp({ content: `🔎 "${req.rawQuery}" 요청을 처리했습니다.`, flags: 64 });
            } catch (err) {
                console.error('[전환 재생 오류]', err);
                await interaction.followUp({
                    content: `❌ 재생 중 오류가 발생했습니다: ${err.message || '알 수 없는 오류'}`,
                    flags: 64,
                }).catch(() => {});
            }
            return;
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        const { commandName } = interaction;

        if (commandName === '진단') {
            const connection = getVoiceConnection(interaction.guildId);
            const report = generateDependencyReport();
            const connState = connection ? connection.state.status : '연결 없음';
            return interaction.reply({
                content: `\`\`\`\n현재 음성 연결 상태: ${connState}\n\n${report}\n\`\`\``,
                flags: 64,
            });
        }

        if (commandName === '보이스설정') {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('select_voice')
                .setPlaceholder('원하는 목소리를 선택하세요')
                .addOptions(PRESET_VOICES.map((v) => ({ label: v.name, value: v.id })));
            const row = new ActionRowBuilder().addComponents(menu);
            return interaction.reply({
                content: '🗣 TTS에서 사용할 본인의 목소리를 선택하세요 (본인에게만 보입니다):',
                components: [row],
                flags: 64,
            });
        }

        if (commandName === '도움말') {
            const embed = new EmbedBuilder()
                .setTitle('봉양이')
                .setDescription('안녕하쉐여. 음악과 TTS를 담당하는 봉양입니돠.')
                .setColor('Blue')
                .addFields(
                    {
                        name: '음악',
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
                        name: 'TTS',
                        value:
                            '`/tts채널설정 채널: 목소리:` [관리자] 지정한 채널의 메시지를 자동으로 읽어줍니다 (ElevenLabs 사용)\n' +
                            '`/tts채널해제` [관리자] 자동 읽기 해제\n' +
                            '`/보이스설정` 내가 읽힐 때 사용할 목소리를 개인적으로 선택합니다\n' +
                            '노래 재생 중 TTS를 시도하거나, TTS 사용 중 노래를 재생하려 하면 전환 버튼이 뜹니다.',
                    }
                );

            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'tts채널설정') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ 관리자만 사용 가능', flags: 64 });
            }
            const channel = interaction.options.getChannel('채널');
            const voiceId = interaction.options.getString('목소리');
            ttsChannels.set(interaction.guildId, channel.id);
            if (voiceId) {
                ttsChannelVoice.set(interaction.guildId, voiceId);
            }
            const voiceLabel = voiceId
                ? voicesCache.find((v) => v.id === voiceId)?.name || voiceId
                : '기본값';
            return interaction.reply(
                `🗣 이제부터 ${channel} 채널에 올라오는 메시지를 자동으로 읽어줍니다. (목소리: ${voiceLabel})\n` +
                `(메시지를 읽으려면 작성자가 음성 채널에 들어가 있어야 하고, 봉양이가 이미 음성 채널에 있다면 그 채널에서 계속 읽습니다)`
            );
        }

        if (commandName === 'tts채널해제') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ 관리자만 사용 가능', flags: 64 });
            }
            ttsChannels.delete(interaction.guildId);
            return interaction.reply('TTS 자동 읽기를 해제했습니다.');
        }

        const voiceChannel = interaction.member.voice.channel;

        if (commandName === '재생') {
            if (!voiceChannel) {
                return interaction.reply({ content: '❌ 먼저 음성 채널에 들어가주세요.', flags: 64 });
            }

            const rawQuery = interaction.options.getString('검색어');

            // 이미 음성 연결이 있는데 DisTube가 관리하는 연결이 아니라면(=TTS가 쓰고 있는 연결)
            // 바로 재생하지 않고 전환 확인을 먼저 받는다.
            const existingConn = getVoiceConnection(interaction.guildId);
            const musicQueueNow = distube.getQueue(interaction.guildId);
            if (existingConn && !musicQueueNow) {
                const requestId = interaction.id;
                pendingPlayRequests.set(requestId, {
                    voiceChannel,
                    rawQuery,
                    textChannel: interaction.channel,
                    member: interaction.member,
                });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`switch_to_music:${requestId}`)
                        .setLabel('🔄 TTS 정지하고 노래 재생')
                        .setStyle(ButtonStyle.Danger)
                );
                return interaction.reply({
                    content: '⚠️ 현재 TTS가 음성 채널을 사용 중이라 바로 재생할 수 없어요. 전환할까요?',
                    components: [row],
                    flags: 64,
                });
            }

            await interaction.deferReply();

            try {
                const url = await resolveToUrl(rawQuery);
                await distube.play(voiceChannel, url, {
                    member: interaction.member,
                    textChannel: interaction.channel,
                });
                return interaction.editReply(`🔎 "${rawQuery}" 요청을 처리했습니다.`);
            } catch (err) {
                console.error('[재생 오류]', err);
                return interaction.editReply(`❌ 재생 중 오류가 발생했습니다: ${err.message || '알 수 없는 오류'}`);
            }
        }

        const queue = distube.getQueue(interaction.guildId);

        if (commandName === '정지') {
            if (!queue) return interaction.reply({ content: '❌ 재생중인 음악이 없습니다.', flags: 64 });
            await distube.stop(interaction.guildId);
            musicSwitchWarned.delete(interaction.guildId);
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
            let left = false;

            if (connection) {
                if (queue) await distube.stop(interaction.guildId).catch(() => {});
                try {
                    connection.destroy();
                } catch (err) {
                    console.error('[나가기] 연결 정리 오류:', err);
                }
                left = true;
            }

            // @discordjs/voice가 연결을 놓쳤어도(예: 연결 실패 후 잔여 상태), 실제로 음성 채널에
            // 남아있는 상태라면 디스코드 음성 상태를 직접 확인해서 강제로 내보냅니다.
            const myVoiceState = interaction.guild.members.me?.voice;
            if (myVoiceState?.channelId) {
                try {
                    await myVoiceState.disconnect();
                    left = true;
                } catch (err) {
                    console.error('[나가기] 강제 퇴장 오류:', err);
                }
            }

            if (!left) {
                return interaction.reply({ content: '❌ 음성 채널에 있지 않습니다.', flags: 64 });
            }
            return interaction.reply('👋 음성 채널에서 나갔습니다.');
        }
    } catch (error) {
        console.error('[인터랙션 처리 오류]', error);
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

client.on('error', (err) => console.error('[클라이언트 에러]', err));
client.on('shardError', (err) => console.error('[샤드 에러]', err));
client.on('warn', (msg) => console.warn('[클라이언트 경고]', msg));

process.on('unhandledRejection', (error) => console.error('[처리되지 않은 Promise 거부]', error));
process.on('uncaughtException', (error) => console.error('[처리되지 않은 예외]', error));

client.login(token);
