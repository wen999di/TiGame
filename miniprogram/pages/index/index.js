/* eslint-disable @typescript-eslint/no-require-imports */
const { request, getWsTicket, wsUrl, API_BASE } = require('../../utils/api');
const { prepareAvatar, restorePreview, materializeAvatar } = require('../../utils/profile');

const SESSION_KEY = 'tigame:wechat-session';
const PROFILE_KEY = 'tigame:wechat-profile';
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
const GAME_LIST = [
  { id: 'undercover', name: '谁是卧底', symbol: '🕵️', minPlayers: 3 },
  { id: 'challenge', name: '不要做挑战', symbol: '🚫', minPlayers: 2 },
  { id: 'mahjong', name: '麻将计分板', symbol: '🀄', minPlayers: 2 },
];

function randomId(length = 18) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnopqrstuvwxyz';
  let value = '';
  for (let i = 0; i < length; i += 1) value += chars[Math.floor(Math.random() * chars.length)];
  return value;
}
function makeRoomId() { return `${randomId(3).toUpperCase()}-${randomId(3).toUpperCase()}`; }
function commandId() { return `${Date.now().toString(36)}-${randomId(14)}`; }
function normalizeRoomId(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).replace(/^(.{3})(.+)$/, '$1-$2'); }
function errorMessage(error) { return error && error.message ? error.message : '操作失败，请稍后重试'; }

Page({
  data: {
    apiBase: API_BASE,
    screen: 'home',
    profile: { nickName: '', avatarData: '', avatarPreview: '' },
    profileInitial: '',
    roomInput: '',
    room: null,
    session: null,
    socketStatus: 'closed',
    isHost: false,
    me: null,
    playersView: [],
    pendingView: [],
    gameList: GAME_LIST,
    secretCard: null,
    lostCard: null,
    pointsInput: '',
    transferTarget: null,
    ucSettings: { undercover: 1, blank: 0, scopes: [1] },
    challengeLives: 3,
    ucReady: false,
    ucVoted: false,
    ucNextReady: false,
    mahjongResetReady: false,
    mahjongSettleReady: false,
    ongoingGameName: '',
    ucScope1: true,
    ucScope2: false,
    ucScope3: false,
    pendingCollectsView: [],
  },

  socketTask: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  connectGeneration: 0,
  manualClose: false,
  avatarLocalCache: Object.create(null),

  async onLoad(options) {
    const storedProfile = wx.getStorageSync(PROFILE_KEY) || {};
    const profile = {
      nickName: String(storedProfile.nickName || '').slice(0, 12),
      avatarData: String(storedProfile.avatarData || ''),
      avatarPreview: '',
    };
    if (profile.avatarData) profile.avatarPreview = await restorePreview(profile.avatarData);
    const session = wx.getStorageSync(SESSION_KEY) || null;
    const invite = normalizeRoomId(options && (options.roomId || options.invite));
    this.setData({ profile, profileInitial: (profile.nickName || '').slice(0, 1), session, roomInput: invite || '' });
    if (session && session.roomId && session.playerId && session.token) {
      this.resumeSession(session);
    } else if (invite) {
      this.setData({ screen: 'join' });
    }
  },

  onUnload() { this.closeSocket(true); },

  onShareAppMessage() {
    const room = this.data.room;
    return {
      title: room ? `加入 TiGame 房间 ${room.roomId}` : 'TiGame 在线聚会游戏',
      path: room ? `/pages/index/index?roomId=${encodeURIComponent(room.roomId)}` : '/pages/index/index',
    };
  },

  showToast(title, icon = 'none') { wx.showToast({ title: String(title).slice(0, 40), icon }); },

  persistProfile(next) {
    const profile = { ...this.data.profile, ...next };
    wx.setStorageSync(PROFILE_KEY, { nickName: profile.nickName, avatarData: profile.avatarData });
    this.setData({ profile, profileInitial: (profile.nickName || '').slice(0, 1) });
  },

  onNicknameInput(event) {
    const nickName = String(event.detail.value || '').trimStart().slice(0, 12);
    this.persistProfile({ nickName });
  },

  async onChooseAvatar(event) {
    const src = event.detail && event.detail.avatarUrl;
    if (!src) return;
    wx.showLoading({ title: '处理头像…', mask: true });
    try {
      const avatar = await prepareAvatar(src);
      this.persistProfile(avatar);
    } catch (error) {
      this.showToast(errorMessage(error));
    } finally {
      wx.hideLoading();
    }
  },

  goHome() { this.setData({ screen: 'home' }); },
  goCreate() { this.setData({ screen: 'create' }); },
  goJoin() { this.setData({ screen: 'join' }); },
  onRoomInput(event) { this.setData({ roomInput: normalizeRoomId(event.detail.value) }); },

  requireNickname() {
    const nickName = String(this.data.profile.nickName || '').trim().slice(0, 12);
    if (!nickName) {
      this.showToast('请先填写微信昵称');
      return '';
    }
    return nickName;
  },

  async createRoom() {
    const hostName = this.requireNickname();
    if (!hostName) return;
    wx.showLoading({ title: '创建房间…', mask: true });
    try {
      let lastError;
      for (let i = 0; i < 5; i += 1) {
        const roomId = makeRoomId();
        try {
          const payload = await request('/api/rooms', {
            method: 'POST',
            data: {
              roomId,
              hostName,
              hostAvatarData: this.data.profile.avatarData || undefined,
              settings: { maxPlayers: 16 },
            },
          });
          const session = { roomId, playerId: payload.playerId, token: payload.token, playerName: hostName };
          this.saveSession(session);
          this.applyRoom(payload.room, session);
          await this.connectSocket(session);
          wx.hideLoading();
          return;
        } catch (error) {
          lastError = error;
          if (error.statusCode !== 409) throw error;
        }
      }
      throw lastError || new Error('创建房间失败');
    } catch (error) {
      wx.hideLoading();
      this.showToast(errorMessage(error));
    }
  },

  async joinRoom() {
    const playerName = this.requireNickname();
    const roomId = normalizeRoomId(this.data.roomInput);
    if (!playerName) return;
    if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomId)) {
      this.showToast('请输入 6 位房间号');
      return;
    }
    wx.showLoading({ title: '申请加入…', mask: true });
    try {
      const previous = wx.getStorageSync(SESSION_KEY) || null;
      const resume = previous && previous.roomId === roomId
        ? { resumePlayerId: previous.playerId, resumeToken: previous.token }
        : {};
      const payload = await request('/api/join-requests', {
        method: 'POST',
        data: {
          roomId,
          playerName,
          avatarData: this.data.profile.avatarData || undefined,
          ...resume,
        },
      });
      const session = { roomId, playerId: payload.playerId, token: payload.token, playerName };
      this.saveSession(session);
      this.setData({ screen: 'pending', room: null });
      await this.connectSocket(session);
    } catch (error) {
      this.showToast(errorMessage(error));
    } finally {
      wx.hideLoading();
    }
  },

  async resumeSession(session) {
    try {
      await request(`/api/rooms/${encodeURIComponent(session.roomId)}?playerId=${encodeURIComponent(session.playerId)}`, {
        token: session.token,
      });
      await this.connectSocket(session);
    } catch (error) {
      if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404 || error.statusCode === 410) {
        this.clearSession();
      } else {
        this.setData({ screen: 'pending' });
        this.scheduleReconnect();
      }
    }
  },

  saveSession(session) {
    wx.setStorageSync(SESSION_KEY, session);
    this.setData({ session });
  },

  clearSession() {
    wx.removeStorageSync(SESSION_KEY);
    this.closeSocket(true);
    this.setData({ session: null, room: null, screen: 'home', secretCard: null, lostCard: null, transferTarget: null });
  },

  closeSocket(manual) {
    this.manualClose = Boolean(manual);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socketTask) {
      try { this.socketTask.close({ code: 1000, reason: 'client close' }); } catch {}
    }
    this.socketTask = null;
    this.setData({ socketStatus: 'closed' });
  },

  async connectSocket(session = this.data.session) {
    if (!session) return;
    const generation = ++this.connectGeneration;
    this.manualClose = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socketTask) {
      try { this.socketTask.close({ code: 1000, reason: 'reconnect' }); } catch {}
      this.socketTask = null;
    }
    this.setData({ socketStatus: 'connecting' });
    try {
      const ticket = await getWsTicket(session);
      if (generation !== this.connectGeneration) return;
      const task = wx.connectSocket({ url: wsUrl(session.roomId, ticket), timeout: 10000 });
      this.socketTask = task;
      task.onOpen(() => {
        if (generation !== this.connectGeneration) return;
        this.reconnectAttempt = 0;
        this.setData({ socketStatus: 'open' });
      });
      task.onMessage((event) => this.handleSocketMessage(event.data, generation));
      task.onError(() => {});
      task.onClose(() => {
        if (generation !== this.connectGeneration) return;
        this.socketTask = null;
        this.setData({ socketStatus: 'closed' });
        if (!this.manualClose && this.data.session) this.scheduleReconnect();
      });
    } catch {
      if (generation !== this.connectGeneration) return;
      this.setData({ socketStatus: 'closed' });
      if (this.data.session && !this.manualClose) this.scheduleReconnect();
    }
  },

  scheduleReconnect() {
    if (this.reconnectTimer || !this.data.session) return;
    const delay = RECONNECT_BACKOFF[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delay);
  },

  handleSocketMessage(raw, generation) {
    if (generation !== this.connectGeneration) return;
    let message;
    try { message = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { return; }
    if (!message) return;
    if (message.type === 'ping') {
      try { if (this.socketTask) this.socketTask.send({ data: JSON.stringify({ type: 'pong' }) }); } catch {}
      return;
    }
    if (message.type === 'hello') {
      if (!message.approved) { this.setData({ screen: 'pending' }); return; }
      if (message.token && this.data.session) this.saveSession({ ...this.data.session, token: message.token });
      if (message.card) this.setData({ secretCard: message.card });
      if (message.room) this.applyRoom(message.room);
      return;
    }
    if (message.type === 'approved') {
      if (message.token && this.data.session) this.saveSession({ ...this.data.session, token: message.token });
      if (message.card) this.setData({ secretCard: message.card });
      this.applyRoom(message.room);
      this.showToast('房主已同意加入', 'success');
      return;
    }
    if (message.type === 'room' && message.room) { this.applyRoom(message.room); return; }
    if (message.type === 'card') { this.setData({ secretCard: message.card || null }); return; }
    if (message.type === 'challenge-lost-card') {
      this.setData({ lostCard: { eventId: message.eventId, action: message.action } });
      return;
    }
    if (message.type === 'mahjong-collect-rejected') {
      this.showToast(`${message.voterName || '有玩家'}拒绝了收取`);
      return;
    }
    if (message.type === 'rejected' || message.type === 'kicked' || message.type === 'left') {
      const text = message.reason || (message.type === 'rejected' ? '加入申请被拒绝' : message.type === 'kicked' ? '你已被移出房间' : '已离开房间');
      this.clearSession();
      this.showToast(text);
      return;
    }
    if (message.type === 'ack' && !message.ok) {
      const map = { INVALID: '操作无效', FORBIDDEN: '没有权限', CONFLICT: '操作冲突', OFFLINE: '连接已断开' };
      this.showToast(map[message.error] || '操作失败');
    }
  },

  applyRoom(room, forcedSession) {
    if (!room) return;
    const session = forcedSession || this.data.session;
    if (!session) return;
    const old = this.data.room;
    if (old && typeof old.revision === 'number' && typeof room.revision === 'number' && room.revision < old.revision) return;
    const me = (room.players || []).find((p) => p.id === session.playerId) || null;
    const isHost = room.hostId === session.playerId;
    const game = room.game || null;
    const playersView = (room.players || []).map((player) => ({
      ...player,
      initial: (player.name || '?').slice(0, 1),
      avatarSrc: '',
      isMe: player.id === session.playerId,
      canKick: isHost && player.id !== session.playerId,
      eliminated: Boolean(game && game.eliminatedPlayerIds && game.eliminatedPlayerIds.includes(player.id)),
      voteReady: Boolean(game && game.voteReadyPlayerIds && game.voteReadyPlayerIds.includes(player.id)),
      voted: Boolean(game && game.votedPlayerIds && game.votedPlayerIds.includes(player.id)),
      nextReady: Boolean(game && game.nextRoundReadyPlayerIds && game.nextRoundReadyPlayerIds.includes(player.id)),
      life: game && game.lives ? (game.lives[player.id] == null ? '-' : game.lives[player.id]) : '-',
      challengeCard: game && game.visibleCards ? (game.visibleCards[player.id] || '') : '',
      score: game && game.scores ? (game.scores[player.id] || 0) : 0,
    }));
    const pendingView = (room.pendingJoinRequests || []).map((item) => ({
      ...item,
      initial: (item.playerName || '?').slice(0, 1),
      avatarSrc: '',
    }));
    const screen = isHost && room.hostInLobby ? 'lobby' : room.phase === 'GAME' ? 'game' : 'lobby';
    const ongoing = GAME_LIST.find((item) => item.id === room.gameId);
    const ucScopes = game && game.kind === 'undercover' && game.settings ? (game.settings.scopes || []) : (this.data.ucSettings.scopes || []);
    const pendingCollectsView = game && game.kind === 'mahjong'
      ? (game.pendingCollects || []).map((item) => ({
          ...item,
          needsMyVote: item.collectorId !== session.playerId && !(item.confirmedPlayerIds || []).includes(session.playerId),
        }))
      : [];
    this.setData({
      room,
      session,
      me,
      isHost,
      playersView,
      pendingView,
      screen,
      ongoingGameName: ongoing ? ongoing.name : '',
      ucScope1: ucScopes.includes(1),
      ucScope2: ucScopes.includes(2),
      ucScope3: ucScopes.includes(3),
      pendingCollectsView,
      ucSettings: game && game.kind === 'undercover' ? { ...game.settings } : this.data.ucSettings,
      challengeLives: game && game.kind === 'challenge' ? game.settings.lives : this.data.challengeLives,
      ucReady: Boolean(game && game.voteReadyPlayerIds && game.voteReadyPlayerIds.includes(session.playerId)),
      ucVoted: Boolean(game && game.votedPlayerIds && game.votedPlayerIds.includes(session.playerId)),
      ucNextReady: Boolean(game && game.nextRoundReadyPlayerIds && game.nextRoundReadyPlayerIds.includes(session.playerId)),
      mahjongResetReady: Boolean(game && game.resetReadyPlayerIds && game.resetReadyPlayerIds.includes(session.playerId)),
      mahjongSettleReady: Boolean(game && game.settleReadyPlayerIds && game.settleReadyPlayerIds.includes(session.playerId)),
    });
    this.hydrateRoomAvatars(room, playersView, pendingView);
  },

  async hydrateRoomAvatars(room, playersView, pendingView) {
    const revision = room.revision;
    const hydrate = async (item, dataField, cachePrefix) => {
      const avatarData = item[dataField];
      if (!avatarData) return item;
      const cacheKey = `${cachePrefix}:${item.id}:${avatarData.length}:${avatarData.slice(-16)}`;
      let avatarSrc = this.avatarLocalCache[cacheKey];
      if (!avatarSrc) {
        try {
          avatarSrc = await materializeAvatar(avatarData, `${cachePrefix}-${item.id}`);
          if (avatarSrc) this.avatarLocalCache[cacheKey] = avatarSrc;
        } catch {
          avatarSrc = '';
        }
      }
      return { ...item, avatarSrc };
    };
    const [nextPlayers, nextPending] = await Promise.all([
      Promise.all(playersView.map((item) => hydrate(item, 'avatarData', 'player'))),
      Promise.all(pendingView.map((item) => hydrate(item, 'avatarData', 'pending'))),
    ]);
    if (!this.data.room || this.data.room.roomId !== room.roomId || this.data.room.revision !== revision) return;
    this.setData({ playersView: nextPlayers, pendingView: nextPending });
  },

  sendCommand(command) {
    if (!this.socketTask || this.data.socketStatus !== 'open') {
      this.showToast('实时连接尚未恢复');
      return false;
    }
    try {
      this.socketTask.send({ data: JSON.stringify({ type: 'command', id: commandId(), command }) });
      return true;
    } catch {
      this.showToast('发送失败，请稍后重试');
      return false;
    }
  },

  enterGame(event) { this.sendCommand({ type: 'enter-game', gameId: event.currentTarget.dataset.gameid }); },
  approveJoin(event) { this.sendCommand({ type: 'approve-join', playerId: event.currentTarget.dataset.playerid }); },
  rejectJoin(event) { this.sendCommand({ type: 'reject-join', playerId: event.currentTarget.dataset.playerid }); },
  kickPlayer(event) {
    const playerId = event.currentTarget.dataset.playerid;
    wx.showModal({ title: '移出玩家', content: '确定将该玩家移出房间？', success: (res) => { if (res.confirm) this.sendCommand({ type: 'kick', playerId }); } });
  },
  leaveRoom() {
    wx.showModal({ title: '离开房间', content: this.data.isHost ? '房主离开后房间会结束，确定离开？' : '确定离开当前房间？', success: (res) => { if (res.confirm) this.sendCommand({ type: 'leave' }); } });
  },
  cancelJoin() { this.sendCommand({ type: 'cancel-join' }); },
  backToLobby() { this.sendCommand({ type: 'back-to-lobby' }); },
  hostInvite() { this.sendCommand({ type: 'host-temporary-leave' }); },
  hostReturnGame() { this.sendCommand({ type: 'host-return-game' }); },

  changeUcNumber(event) {
    if (!this.data.room || !this.data.room.game || !this.data.isHost) return;
    const key = event.currentTarget.dataset.key;
    const delta = Number(event.currentTarget.dataset.delta || 0);
    const next = { ...this.data.ucSettings };
    next[key] = Math.max(key === 'undercover' ? 1 : 0, Number(next[key] || 0) + delta);
    this.setData({ ucSettings: next });
    this.sendCommand({ type: 'undercover-settings', settings: next });
  },
  toggleUcScope(event) {
    const scope = Number(event.currentTarget.dataset.scope);
    const current = this.data.ucSettings.scopes || [1];
    let scopes = current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope].sort();
    if (!scopes.length) scopes = [scope];
    const next = { ...this.data.ucSettings, scopes };
    this.setData({ ucSettings: next, ucScope1: scopes.includes(1), ucScope2: scopes.includes(2), ucScope3: scopes.includes(3) });
    this.sendCommand({ type: 'undercover-settings', settings: next });
  },
  startUndercover() { this.sendCommand({ type: 'undercover-start' }); },
  toggleVoteReady() { this.sendCommand({ type: 'vote-ready', ready: !this.data.ucReady }); },
  votePlayer(event) { this.sendCommand({ type: 'vote', targetId: event.currentTarget.dataset.playerid }); },
  toggleNextRound() { this.sendCommand({ type: 'next-round-ready', ready: !this.data.ucNextReady }); },
  restartUndercover() { this.sendCommand({ type: 'restart-game' }); },

  changeChallengeLives(event) {
    const delta = Number(event.currentTarget.dataset.delta || 0);
    const lives = Math.max(1, Math.min(30, Number(this.data.challengeLives || 3) + delta));
    this.setData({ challengeLives: lives });
    this.sendCommand({ type: 'challenge-settings', settings: { lives } });
  },
  startChallenge() { this.sendCommand({ type: 'challenge-start' }); },
  challengeAction(event) {
    const playerId = event.currentTarget.dataset.playerid;
    const action = event.currentTarget.dataset.action;
    if (action === 'penalize') this.sendCommand({ type: 'challenge-penalize', playerId });
    else if (action === 'swap') this.sendCommand({ type: 'challenge-swap', playerId });
    else if (action === 'reward') this.sendCommand({ type: 'challenge-reward', playerId });
  },
  dismissLostCard() {
    const card = this.data.lostCard;
    if (!card) return;
    this.sendCommand({ type: 'challenge-lost-card-dismiss', eventId: card.eventId });
    this.setData({ lostCard: null });
  },
  restartChallenge() { this.sendCommand({ type: 'challenge-restart' }); },

  selectTransferTarget(event) {
    const playerId = event.currentTarget.dataset.playerid;
    const player = (this.data.room.players || []).find((item) => item.id === playerId);
    this.setData({ transferTarget: player ? { id: player.id, name: player.name } : null });
  },
  onPointsInput(event) { this.setData({ pointsInput: String(event.detail.value || '').replace(/\D/g, '').slice(0, 5) }); },
  sendTransfer() {
    const target = this.data.transferTarget;
    const points = Number(this.data.pointsInput);
    if (!target || !Number.isInteger(points) || points < 1 || points > 99999) { this.showToast('请选择玩家并输入 1–99999 分'); return; }
    if (this.sendCommand({ type: 'mahjong-transfer', targetId: target.id, points, operationId: commandId() })) this.setData({ pointsInput: '', transferTarget: null });
  },
  collectFromAll() {
    const points = Number(this.data.pointsInput);
    if (!Number.isInteger(points) || points < 1 || points > 99999) { this.showToast('请输入 1–99999 分'); return; }
    if (this.sendCommand({ type: 'mahjong-collect', points, operationId: commandId() })) this.setData({ pointsInput: '' });
  },
  voteCollect(event) {
    this.sendCommand({ type: 'mahjong-collect-vote', collectId: event.currentTarget.dataset.collectid, approve: event.currentTarget.dataset.approve === 'true' });
  },
  toggleMahjongReset() { this.sendCommand({ type: 'mahjong-reset-ready', ready: !this.data.mahjongResetReady }); },
  toggleMahjongSettle() { this.sendCommand({ type: 'mahjong-settle-ready', ready: !this.data.mahjongSettleReady }); },
});
