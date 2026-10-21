const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// Estructura de salas: roomId -> { id, name, players: [], settings: {}, started: false }
const rooms = new Map();

// Servidor HTTP base (necesario para que cPanel Passenger y healthchecks respondan 200 OK)
const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
        status: 'online',
        service: 'Ludo WebSocket Multiplayer Server',
        rooms_active: rooms.size,
        timestamp: new Date().toISOString()
    }));
});

const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
    console.log(`[Ludo Server] Servidor activo escuchando en ${PORT}`);
});

const COLOR_SEATS_2P = ['red', 'yellow'];
const COLOR_SEATS_3P = ['red', 'green', 'yellow'];
const COLOR_SEATS_4P = ['red', 'green', 'yellow', 'blue'];

function getAvailableColor(room, maxPlayers) {
    const seatList = maxPlayers === 2 ? COLOR_SEATS_2P : (maxPlayers === 3 ? COLOR_SEATS_3P : COLOR_SEATS_4P);
    const takenColors = room.players.map(p => p.color);
    for (const color of seatList) {
        if (!takenColors.includes(color)) {
            return color;
        }
    }
    return null;
}

function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const payload = JSON.stringify(message);
    room.players.forEach(player => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN && player.ws !== excludeWs) {
            player.ws.send(payload);
        }
    });
}

function getRoomsList() {
    const list = [];
    rooms.forEach((room) => {
        list.push({
            id: room.id,
            name: room.name || `Sala #${room.id}`,
            hostName: room.players.length > 0 ? room.players[0].name : 'Anfitrión',
            currentPlayers: room.players.length,
            maxPlayers: room.settings.playerCount || 4,
            firstTurnMode: room.settings.firstTurnMode || 'random',
            isPrivate: Boolean(room.settings.isPrivate),
            started: room.started
        });
    });
    return list;
}

function broadcastRoomsList() {
    const payload = JSON.stringify({
        event: 'ROOMS_LIST',
        rooms: getRoomsList()
    });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function handlePlayerDefinitiveLeave(room, player, wasInGame) {
    if (!room || !player) return;
    if (player.graceTimeout) {
        clearTimeout(player.graceTimeout);
        player.graceTimeout = null;
    }

    room.players = room.players.filter(p => p !== player);

    if (room.players.length === 0) {
        rooms.delete(room.id);
        console.log(`[Destroy] Sala #${room.id} vacía, eliminada.`);
    } else {
        if (player.isHost && room.players.length > 0) {
            const connectedPlayer = room.players.find(p => !p.isDisconnected) || room.players[0];
            connectedPlayer.isHost = true;
        }

        const remainingActive = room.players.filter(p => !p.isDisconnected);

        if (wasInGame && room.started && remainingActive.length === 1) {
            room.started = false;
            const winner = remainingActive[0];
            console.log(`[Forfeit Winner] ${winner.name} gana automáticamente sala #${room.id} tras abandono definitivo.`);
            if (winner.ws && winner.ws.readyState === WebSocket.OPEN) {
                winner.ws.send(JSON.stringify({
                    event: 'MATCH_WON_BY_FORFEIT',
                    winnerName: winner.name,
                    winnerColor: winner.color,
                    rewardCoins: 500,
                    message: `${player.name} abandonó la partida. ¡Eres el ganador automático!`
                }));
            }
        } else if (room.players.length <= 1) {
            room.started = false;
        }

        broadcastToRoom(room.id, {
            event: 'PLAYER_LEFT',
            wasGameStarted: wasInGame,
            player: {
                id: player.id,
                name: player.name,
                color: player.color
            },
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                color: p.color,
                isHost: p.isHost,
                isDisconnected: Boolean(p.isDisconnected)
            }))
        });
    }
    broadcastRoomsList();
}

wss.on('connection', (ws) => {
    let currentRoomId = null;
    let currentPlayer = null;

    // Al conectarse cualquier cliente, enviarle de inmediato la lista de salas activas
    ws.send(JSON.stringify({
        event: 'ROOMS_LIST',
        rooms: getRoomsList()
    }));

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            const { action } = data;

            if (action === 'LIST_ROOMS') {
                ws.send(JSON.stringify({
                    event: 'ROOMS_LIST',
                    rooms: getRoomsList()
                }));

            } else if (action === 'CREATE_ROOM') {
                const { roomName, playerName, playerCount, firstTurnMode, isPrivate, password } = data;

                // Generar ID de sala limpio de 2 dígitos (#01, #02...)
                let candidateNum = 1;
                let newRoomId = String(candidateNum).padStart(2, '0');
                while (rooms.has(newRoomId)) {
                    candidateNum++;
                    newRoomId = String(candidateNum).padStart(2, '0');
                }
                currentRoomId = newRoomId;

                const title = (roomName && roomName.trim()) 
                    ? roomName.trim().slice(0, 24) 
                    : `Sala de ${playerName || 'Amigos'} #${newRoomId}`;

                const room = {
                    id: newRoomId,
                    name: title,
                    players: [],
                    settings: {
                        playerCount: playerCount || 4,
                        firstTurnMode: firstTurnMode || 'random',
                        isPrivate: Boolean(isPrivate),
                        password: (isPrivate && password) ? String(password).trim() : null
                    },
                    started: false,
                    turnIndex: 0
                };
                rooms.set(newRoomId, room);

                // El creador es siempre el Anfitrión (Host) y tiene color Rojo
                currentPlayer = {
                    id: 'p_' + Math.random().toString(36).substring(2, 9),
                    name: playerName || 'Anfitrión',
                    color: 'red',
                    isHost: true,
                    ws: ws
                };
                room.players.push(currentPlayer);

                console.log(`[Create] ${currentPlayer.name} creó sala #${newRoomId} "${room.name}" (${room.settings.isPrivate ? 'Privada' : 'Pública'})`);

                ws.send(JSON.stringify({
                    event: 'JOINED_SUCCESS',
                    roomId: newRoomId,
                    roomName: room.name,
                    player: {
                        id: currentPlayer.id,
                        name: currentPlayer.name,
                        color: currentPlayer.color,
                        isHost: true
                    },
                    room: {
                        id: room.id,
                        name: room.name,
                        started: room.started,
                        settings: room.settings,
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            color: p.color,
                            isHost: p.isHost
                        }))
                    }
                }));

                broadcastRoomsList();

            } else if (action === 'JOIN_ROOM') {
                const { roomId, playerName, playerCount, firstTurnMode, password } = data;
                currentRoomId = roomId || '01';

                let room = rooms.get(currentRoomId);
                if (!room) {
                    // Si se unió con ID directo (ej. ?sala=7742)
                    room = {
                        id: currentRoomId,
                        name: `Sala #${currentRoomId}`,
                        players: [],
                        settings: {
                            playerCount: playerCount || 4,
                            firstTurnMode: firstTurnMode || 'random',
                            isPrivate: Boolean(password),
                            password: password ? String(password).trim() : null
                        },
                        started: false,
                        turnIndex: 0
                    };
                    rooms.set(currentRoomId, room);
                }

                if (room.started) {
                    ws.send(JSON.stringify({ event: 'ERROR', message: 'La partida de esta sala ya ha comenzado.' }));
                    return;
                }

                // Validar clave si la sala es privada
                if (room.settings.isPrivate && room.settings.password) {
                    if (room.players.length > 0) { // si no es el primer jugador
                        const enteredPass = password ? String(password).trim() : '';
                        if (enteredPass !== String(room.settings.password).trim()) {
                            ws.send(JSON.stringify({
                                event: 'ERROR',
                                code: 'INVALID_PASSWORD',
                                roomId: currentRoomId,
                                message: 'Clave de acceso incorrecta.'
                            }));
                            return;
                        }
                    }
                }

                const maxPlayers = room.settings.playerCount || 4;
                const assignedColor = getAvailableColor(room, maxPlayers);
                if (!assignedColor) {
                    ws.send(JSON.stringify({ event: 'ERROR', message: 'La sala ya está completa.' }));
                    return;
                }

                const isHost = room.players.length === 0;
                currentPlayer = {
                    id: 'p_' + Math.random().toString(36).substring(2, 9),
                    name: playerName || (isHost ? 'Host' : 'Jugador'),
                    color: assignedColor,
                    isHost: isHost,
                    ws: ws
                };
                room.players.push(currentPlayer);

                console.log(`[Join] ${currentPlayer.name} (${currentPlayer.color}) se unió a sala #${currentRoomId}. Total: ${room.players.length}`);

                ws.send(JSON.stringify({
                    event: 'JOINED_SUCCESS',
                    roomId: currentRoomId,
                    roomName: room.name,
                    player: {
                        id: currentPlayer.id,
                        name: currentPlayer.name,
                        color: currentPlayer.color,
                        isHost: currentPlayer.isHost
                    },
                    room: {
                        id: room.id,
                        name: room.name,
                        started: room.started,
                        settings: room.settings,
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            color: p.color,
                            isHost: p.isHost
                        }))
                    }
                }));

                broadcastToRoom(currentRoomId, {
                    event: 'ROOM_UPDATE',
                    players: room.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        color: p.color,
                        isHost: p.isHost
                    })),
                    settings: room.settings
                }, ws);

                broadcastRoomsList();

            } else if (action === 'LEAVE_ROOM') {
                if (currentRoomId && currentPlayer) {
                    const room = rooms.get(currentRoomId);
                    if (room) {
                        const wasGameStarted = Boolean(room.started);
                        console.log(`[Leave] ${currentPlayer.name} salió voluntariamente de sala #${currentRoomId} (en partida: ${wasGameStarted})`);

                        if (wasGameStarted) {
                            ws.send(JSON.stringify({
                                event: 'FORFEIT_PENALTY',
                                penaltyCoins: 300,
                                message: 'Has abandonado una partida en curso. Perdiste 300 monedas.'
                            }));
                        }

                        handlePlayerDefinitiveLeave(room, currentPlayer, wasGameStarted);
                    }
                    currentRoomId = null;
                    currentPlayer = null;
                    ws.send(JSON.stringify({ event: 'LEFT_ROOM_SUCCESS' }));
                }

            } else if (action === 'UPDATE_ROOM_SETTINGS') {
                const room = rooms.get(currentRoomId);
                if (!room || !currentPlayer || !currentPlayer.isHost) return;

                if (data.playerCount) {
                    const newCount = Math.max(room.players.length, parseInt(data.playerCount, 10));
                    room.settings.playerCount = newCount;
                }
                if (data.firstTurnMode) {
                    room.settings.firstTurnMode = data.firstTurnMode;
                }
                if (data.roomName && data.roomName.trim()) {
                    room.name = data.roomName.trim().slice(0, 24);
                }

                console.log(`[Settings] Sala #${currentRoomId} actualizada: maxPlayers=${room.settings.playerCount}, turnMode=${room.settings.firstTurnMode}`);

                broadcastToRoom(currentRoomId, {
                    event: 'ROOM_UPDATE',
                    players: room.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        color: p.color,
                        isHost: p.isHost
                    })),
                    settings: room.settings,
                    roomName: room.name
                });
                broadcastRoomsList();

            } else if (action === 'START_GAME') {
                const room = rooms.get(currentRoomId);
                if (!room) return;
                if (!currentPlayer || !currentPlayer.isHost) return;

                if (data.settings) {
                    room.settings = { ...room.settings, ...data.settings };
                }
                room.started = true;

                const activeCount = room.settings.playerCount || 4;
                const startTurnIndex = room.settings.firstTurnMode === 'random' 
                    ? Math.floor(Math.random() * activeCount) 
                    : 0;
                room.settings.startTurnIndex = startTurnIndex;

                console.log(`[Start] Partida iniciada en sala #${currentRoomId} ("${room.name}") con ${room.players.length} humanos. Inicia turno: ${startTurnIndex}`);

                broadcastToRoom(currentRoomId, {
                    event: 'GAME_STARTED',
                    settings: room.settings,
                    players: room.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        color: p.color,
                        isHost: p.isHost
                    }))
                });

                broadcastRoomsList();

            } else if (action === 'ROLL_DICE') {
                const room = rooms.get(currentRoomId);
                if (!room) return;

                const diceValue = data.diceValue || (Math.floor(Math.random() * 6) + 1);

                broadcastToRoom(currentRoomId, {
                    event: 'DICE_ROLLED',
                    color: data.color || (currentPlayer ? currentPlayer.color : 'red'),
                    diceValue: diceValue
                });

            } else if (action === 'MOVE_PAWN') {
                broadcastToRoom(currentRoomId, {
                    event: 'PAWN_MOVED',
                    color: data.color,
                    pawnIndex: data.pawnIndex
                }, ws);

            } else if (action === 'EMOJI') {
                broadcastToRoom(currentRoomId, {
                    event: 'EMOJI_RECEIVED',
                    emoji: data.emoji,
                    senderName: currentPlayer ? currentPlayer.name : '',
                    color: currentPlayer ? currentPlayer.color : 'red'
                }, ws);

            } else if (action === 'PAUSE_GAME') {
                broadcastToRoom(currentRoomId, {
                    event: 'GAME_PAUSED',
                    by: currentPlayer ? currentPlayer.name : 'Un jugador'
                }, ws);

            } else if (action === 'RESUME_GAME') {
                broadcastToRoom(currentRoomId, {
                    event: 'GAME_RESUMED',
                    by: currentPlayer ? currentPlayer.name : 'Un jugador'
                }, ws);

            } else if (action === 'CANCEL_MATCH') {
                const room = rooms.get(currentRoomId);
                if (room) {
                    room.started = false;
                }
                broadcastToRoom(currentRoomId, {
                    event: 'MATCH_CANCELLED',
                    by: currentPlayer ? currentPlayer.name : 'Un jugador'
                });
                broadcastRoomsList();

            } else if (action === 'MATCH_WON') {
                const room = rooms.get(currentRoomId);
                if (room) {
                    room.started = false;
                    const wColor = data.winnerColor || (currentPlayer ? currentPlayer.color : 'red');
                    const winnerPlayer = room.players.find(p => p.color === wColor) || currentPlayer;
                    const wName = (winnerPlayer && winnerPlayer.name) ? winnerPlayer.name : (data.winnerName || 'Ganador');

                    console.log(`[Victory] Partida finalizada en sala #${currentRoomId}. Ganador: ${wName} (${wColor})`);

                    broadcastToRoom(currentRoomId, {
                        event: 'GAME_OVER',
                        winnerColor: wColor,
                        winnerName: wName,
                        rewardCoins: 500
                    });

                    broadcastRoomsList();
                }
            } else if (action === 'RECONNECT_ROOM') {
                const { roomId, playerId, color } = data;
                currentRoomId = roomId;
                const room = rooms.get(roomId);

                if (!room) {
                    ws.send(JSON.stringify({ event: 'RECONNECT_FAILED', message: 'La sala ya no existe o finalizó.' }));
                    return;
                }

                let existingPlayer = room.players.find(p => p.id === playerId || (p.color === color && p.isDisconnected));
                if (!existingPlayer) {
                    existingPlayer = room.players.find(p => p.color === color);
                }

                if (!existingPlayer) {
                    ws.send(JSON.stringify({ event: 'RECONNECT_FAILED', message: 'No se encontró tu asiento en esta partida.' }));
                    return;
                }

                if (existingPlayer.graceTimeout) {
                    clearTimeout(existingPlayer.graceTimeout);
                    existingPlayer.graceTimeout = null;
                }

                existingPlayer.ws = ws;
                existingPlayer.isDisconnected = false;
                currentPlayer = existingPlayer;

                console.log(`[Reconnected] ¡${existingPlayer.name} (${existingPlayer.color}) se reconectó exitosamente a sala #${roomId}!`);

                ws.send(JSON.stringify({
                    event: 'RECONNECT_SUCCESS',
                    roomId: room.id,
                    roomName: room.name,
                    player: {
                        id: existingPlayer.id,
                        name: existingPlayer.name,
                        color: existingPlayer.color,
                        isHost: existingPlayer.isHost
                    },
                    room: {
                        id: room.id,
                        name: room.name,
                        started: room.started,
                        settings: room.settings,
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            color: p.color,
                            isHost: p.isHost,
                            isDisconnected: Boolean(p.isDisconnected)
                        }))
                    }
                }));

                broadcastToRoom(roomId, {
                    event: 'PLAYER_RECONNECTED',
                    player: {
                        id: existingPlayer.id,
                        name: existingPlayer.name,
                        color: existingPlayer.color
                    }
                });

                // Solicitar sincronización del tablero al Host o a cualquier otro jugador conectado
                const hostOrOther = room.players.find(p => p !== existingPlayer && p.ws && p.ws.readyState === WebSocket.OPEN);
                if (hostOrOther) {
                    hostOrOther.ws.send(JSON.stringify({
                        event: 'REQUEST_GAME_SYNC',
                        targetPlayerId: existingPlayer.id
                    }));
                }

                broadcastRoomsList();

            } else if (action === 'SUBMIT_GAME_SYNC') {
                const room = rooms.get(currentRoomId);
                if (room && data.targetPlayerId) {
                    const targetPlayer = room.players.find(p => p.id === data.targetPlayerId);
                    if (targetPlayer && targetPlayer.ws && targetPlayer.ws.readyState === WebSocket.OPEN) {
                        targetPlayer.ws.send(JSON.stringify({
                            event: 'GAME_SYNC_RESTORE',
                            syncData: data.syncData
                        }));
                    }
                }
            }
        } catch (err) {
            console.error('[Error msg]', err);
        }
    });

    ws.on('close', () => {
        if (currentRoomId && currentPlayer) {
            const room = rooms.get(currentRoomId);
            if (room) {
                const wasGameStarted = Boolean(room.started);
                console.log(`[Disconnect] ${currentPlayer.name} se desconectó de sala #${currentRoomId} (en partida: ${wasGameStarted})`);

                if (wasGameStarted) {
                    // MODO TOLERANCIA Y RECONEXIÓN: 30s de gracia sin expulsión inmediata
                    currentPlayer.ws = null;
                    currentPlayer.isDisconnected = true;
                    console.log(`[Grace Period] ${currentPlayer.name} tiene 30s para reconectarse a sala #${currentRoomId}`);

                    broadcastToRoom(currentRoomId, {
                        event: 'PLAYER_DISCONNECTED_GRACE',
                        player: {
                            id: currentPlayer.id,
                            name: currentPlayer.name,
                            color: currentPlayer.color
                        },
                        graceSeconds: 30
                    });

                    if (currentPlayer.graceTimeout) {
                        clearTimeout(currentPlayer.graceTimeout);
                    }

                    const targetPlayer = currentPlayer;
                    currentPlayer.graceTimeout = setTimeout(() => {
                        targetPlayer.graceTimeout = null;
                        const r = rooms.get(currentRoomId);
                        if (!r) return;

                        if (targetPlayer.isDisconnected && r.players.includes(targetPlayer)) {
                            console.log(`[Grace Expired] 30s expirados para ${targetPlayer.name} en sala #${currentRoomId}. Declarando abandono.`);
                            handlePlayerDefinitiveLeave(r, targetPlayer, true);
                        }
                    }, 30000);

                    return;
                }

                // Si NO estaba en partida (estaba en sala de espera), salida inmediata
                handlePlayerDefinitiveLeave(room, currentPlayer, false);
            }
        }
    });
});
