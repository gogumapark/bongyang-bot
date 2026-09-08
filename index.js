// ════════════════════════════════════════
// 봉양이 — TTS 전용 디스코드 봇
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
    StringSelectMenuBuilder,
} = require('discord.js');
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
const { Readable } = require('stream');

// ── 헬스체크용 최소 웹서버 ──
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
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
    console.error('[치명적 오류] TOKEN 또는 CLIENT_ID 환경변수가 설정되지 않았습니다.');
    process.exit(1);
}

// ════════════════════════════════════════
// 음성 연결 헬퍼
// ════════════════════════════════════════

async function connectToVoiceChannel(voiceChannel, timeoutMs = 30000) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
        return connection;
    } catch (err) {
        console.error('[음성 연결 실패]', err.message);
        try { connection.destroy(); } catch {}
        throw err;
    }
}

// ════════════════════════════════════════
// TTS - ElevenLabs
// ════════════════════════════════════════

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!ELEVENLABS_API_KEY) {
    console.warn('[경고] ELEVENLABS_API_KEY 환경변수가 설정되지 않았습니다. TTS 기능이 작동하지 않습니다.');
}

let voicesCache = [];
const DEFAULT_VOICE_ID_FALLBACK = '21m00Tcm4TlvDq8ikWAM'; // Rachel

const PRESET_VOICES = [
    { id: 'Dyrk0BXUrEfP36mgXeJD', name: '여성 1 - 활발한 목소리' },
    { id: 'Y3UKelKJZyjkuNLnYsLm', name: '여성 2 - 나레이터 목소리' },
    { id: 'ZJ7CnFUgK4JZnvPqF4mL', name: '남성 1 - 차분한 목소리' },
    { id: '1KNqBv4TutQtzSIACsMC', name: '남성 2 - AI영상 나레이터 목소리' },
];

const userVoicePref = new Map(); // userId -> voiceId

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
            '-loglevel', 'error',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
        ],
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
// TTS - 채널 자동 읽기 (봇이 음성채널에 있을 때만 동작, 자동 참여 없음)
// ════════════════════════════════════════

const ttsChannels = new Map();
const ttsChannelVoice = new Map();
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

    const connection = getVoiceConnection(guildId);
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
        state.queue = [];
        return;
    }

    state.playing = true;

    try {
        const chosenVoiceId =
            userVoicePref.get(next.authorId) ||
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
        console.error('[TTS 재생 오류]', err.message);
    }

    state.playing = false;
    processTTSQueue(guildId);
}

function enqueueChannelTTS(message) {
    const connection = getVoiceConnection(message.guildId);
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) return;

    const state = getTTSGuildState(message.guildId);
    if (state.queue.length >= 10) return;

    let text = message.content.trim();
    if (!text) return;
    if (text.length > 200) text = text.slice(0, 200) + ' (이하 생략)';

    state.queue.push({ text, authorId: message.author.id });
    processTTSQueue(message.guildId);
}

// ════════════════════════════════════════
// 슬래시 명령어 정의
// ════════════════════════════════════════

const commands = [
    new SlashCommandBuilder().setName('들어와').setDescription('봉양이가 내 음성 채널로 들어옵니다'),

    new SlashCommandBuilder().setName('저리가').setDescription('봉양이를 음성 채널에서 내보냅니다'),

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
                .setDescription('자동읽기에 사용할 기본 목소리 (입력하면 자동완성)')
                .setAutocomplete(true)
        ),

    new SlashCommandBuilder()
        .setName('tts채널해제')
        .setDescription('[관리자] TTS 자동 읽기를 해제합니다'),

    new SlashCommandBuilder().setName('보이스설정').setDescription('TTS에서 사용할 내 목소리를 선택합니다'),

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

    if (!interaction.isChatInputCommand()) return;

    try {
        const { commandName } = interaction;

        if (commandName === '들어와') {
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return interaction.reply({ content: '❌ 먼저 음성 채널에 들어가주세요.', flags: 64 });
            }
            await interaction.deferReply();
            try {
                await connectToVoiceChannel(voiceChannel);
                return interaction.editReply(`🎧 ${voiceChannel} 채널로 들어왔습니다.`);
            } catch (err) {
                return interaction.editReply('❌ 음성 채널 연결에 실패했습니다.');
            }
        }

        if (commandName === '저리가') {
            const connection = getVoiceConnection(interaction.guildId);
            const memberVoiceState = interaction.guild.members.me?.voice;

            if (!connection && !memberVoiceState?.channel) {
                return interaction.reply({ content: '❌ 음성 채널에 있지 않습니다.', flags: 64 });
            }

            if (connection) {
                try { connection.destroy(); } catch {}
            }
            if (memberVoiceState?.channel) {
                try { await memberVoiceState.disconnect(); } catch {}
            }

            return interaction.reply('👋 음성 채널에서 나갔습니다.');
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
                .setDescription('안녕하쉐여. TTS 전담 봉양입니돠.')
                .setColor('Blue')
                .addFields({
                    name: '명령어',
                    value:
                        '`/들어와` 내 음성 채널로 봉양이 참여\n' +
                        '`/저리가` 음성 채널에서 퇴장\n' +
                        '`/tts채널설정 채널: 목소리:` [관리자] 지정한 채널 메시지를 자동으로 읽어줍니다\n' +
                        '`/tts채널해제` [관리자] 자동 읽기 해제\n' +
                        '`/보이스설정` 내 목소리 개인 설정',
                });

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
            return interaction.reply(`${channel} 채널에 올라오는 메시지를 읽습니다.`);
        }

        if (commandName === 'tts채널해제') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ 관리자만 사용 가능', flags: 64 });
            }
            ttsChannels.delete(interaction.guildId);
            ttsChannelVoice.delete(interaction.guildId);
            return interaction.reply('TTS 자동 읽기를 해제했습니다.');
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

process.on('unhandledRejection', (error) => console.error('[처리되지 않은 Promise 거부]', error));
process.on('uncaughtException', (error) => console.error('[처리되지 않은 예외]', error));

client.login(token);
