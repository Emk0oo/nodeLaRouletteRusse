import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { readFile } from "fs/promises";

const app = express();
const server = createServer(app);

// server.js - Mettre à jour la configuration CORS
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://la-roulette-russe.vercel.app",
      /\.vercel\.app$/,
      /localhost:\d+$/,
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Stockage des rooms et des joueurs
const rooms = new Map();

// Charger les questions
const data = await readFile("./questions.json", "utf-8");
const questions = JSON.parse(data);

io.on("connection", (socket) => {
  console.log("Client connecté :", socket.id);

  // Fonction utilitaire pour mélanger un tableau
  function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // Timer pour les questions
  let countdownInterval;

  // Créer une nouvelle room
  socket.on("create-room", (gameId) => {
    if (rooms.has(gameId)) {
      socket.emit("room-error", "Cette room existe déjà");
      return;
    }

    rooms.set(gameId, {
      id: gameId,
      host: socket.id,
      players: [],
      status: "waiting",
      currentQuestionIndex: -1,
      playerAnswers: new Map(),
      questionTimer: null,
      resultsTimer: null,
      timeRemaining: 5,
      createdAt: new Date(),
    });

    socket.join(gameId);
    socket.emit("room-created", { gameId, room: rooms.get(gameId) });
    console.log(`Room ${gameId} créée par ${socket.id}`);
  });

  // Rejoindre une room
  socket.on("join-room", ({ gameId, playerName }) => {
    const room = rooms.get(gameId);

    if (!room) {
      socket.emit("join-error", "Cette room n'existe pas");
      return;
    }

    if (room.status !== "waiting") {
      socket.emit("join-error", "La partie a déjà commencé");
      return;
    }

    const player = {
      id: socket.id,
      name: playerName,
      score: 2,
      previousScore: 2,
      hasAnswered: false,
      currentAnswer: null,
      lastPointChange: 0,
      eliminated: false,
      joinedAt: new Date(),
      questions: shuffle([...questions]), // Mélanger les questions pour chaque joueur
      currentQuestionIndex: -1,
    };

    room.players.push(player);
    socket.join(gameId);

    io.to(gameId).emit("player-joined", { player, players: room.players });
    socket.emit("joined-room", { gameId, players: room.players });

    console.log(`${playerName} (${socket.id}) a rejoint la room ${gameId}`);
  });

  // Démarrer la partie
  socket.on("start-game", (gameId) => {
    const room = rooms.get(gameId);

    if (!room) {
      socket.emit("error", "Room introuvable");
      return;
    }

    if (room.host !== socket.id) {
      socket.emit("error", "Seul l'hôte peut démarrer la partie");
      return;
    }

    if (room.players.length < 1) {
      socket.emit("error", "Il faut au moins 1 joueur pour commencer");
      return;
    }

    room.status = "playing";
    room.currentQuestionIndex = -1;

    socket.emit("game-started-admin", { gameId });
    socket.to(gameId).emit("game-started-player", { gameId });

    // Envoyer la première question après 3 secondes
    setTimeout(() => {
      sendNextQuestion(gameId);
    }, 3000);

    console.log(
      `Partie ${gameId} démarrée avec ${room.players.length} joueurs`
    );
  });

  // Recevoir une réponse
  socket.on("submit-answer", ({ gameId, answer }) => {
    const room = rooms.get(gameId);
    if (!room || room.status !== "playing") return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.hasAnswered || player.eliminated) return;

    player.hasAnswered = true;
    player.currentAnswer = answer;

    // Notifier tous les clients qu'un joueur a répondu
    const activePlayers = room.players.filter((p) => !p.eliminated);
    io.to(gameId).emit("player-answered", {
      playerId: player.id,
      playerName: player.name,
      totalAnswered: activePlayers.filter((p) => p.hasAnswered).length,
      totalPlayers: activePlayers.length,
    });

    console.log(`${player.name} a répondu: ${answer}`);
  });

  function sendNextQuestion(gameId) {
    const room = rooms.get(gameId);
    if (!room) return;

    // Filtrer les joueurs actifs (non éliminés)
    const activePlayers = room.players.filter((p) => !p.eliminated);

    if (activePlayers.length === 0) {
      endGame(gameId);
      return;
    }

    // Chaque joueur actif avance d'une question dans sa propre liste
    activePlayers.forEach((player) => {
      player.currentQuestionIndex++;
      player.hasAnswered = false;
      player.currentAnswer = null;
      player.previousScore = player.score;
      player.lastPointChange = 0;
    });

    const totalQuestions = questions.length;

    // Vérifier si tous les joueurs actifs ont terminé leurs questions
    const allFinished = activePlayers.every(
      (p) => p.currentQuestionIndex >= p.questions.length
    );
    if (allFinished) {
      endGame(gameId);
      return;
    }

    // Envoyer à chaque joueur actif sa propre question
    activePlayers.forEach((player) => {
      if (player.currentQuestionIndex < player.questions.length) {
        const q = player.questions[player.currentQuestionIndex];

        io.to(player.id).emit("new-question", {
          question: q.question,
          options: q.options,
          questionNumber: player.currentQuestionIndex + 1,
          totalQuestions: totalQuestions,
          timeRemaining: 5,
        });
      }
    });

    room.timeRemaining = 5;

    // Démarrer le compte à rebours
    countdownInterval = setInterval(() => {
      room.timeRemaining--;
      io.to(gameId).emit("time-update", { timeRemaining: room.timeRemaining });

      if (room.timeRemaining <= 0) {
        clearInterval(countdownInterval);
        endQuestion(gameId);
      }
    }, 1000);
  }

  function endQuestion(gameId) {
    const room = rooms.get(gameId);
    if (!room) return;

    clearInterval(countdownInterval);

    const results = [];
    const eliminatedPlayers = [];

    // Traiter chaque joueur
    room.players.forEach((player) => {
      // Ignorer les joueurs déjà éliminés
      if (player.eliminated) {
        results.push({
          playerId: player.id,
          playerName: player.name,
          answered: false,
          answer: null,
          isCorrect: false,
          previousScore: player.score,
          newScore: player.score,
          pointChange: 0,
          eliminated: true,
        });
        return;
      }

      const currentQuestion = player.questions[player.currentQuestionIndex];
      const correctAnswer = currentQuestion.correctAnswer;

      if (player.hasAnswered && player.currentAnswer === correctAnswer) {
        player.score += 1;
        player.lastPointChange = 1;
      } else {
        player.score = Math.max(0, player.score - 1);
        player.lastPointChange = -1;
      }

      // Vérifier si le joueur est éliminé
      if (player.score <= 0) {
        player.eliminated = true;
        eliminatedPlayers.push(player);
      }

      results.push({
        playerId: player.id,
        playerName: player.name,
        answered: player.hasAnswered,
        answer: player.currentAnswer,
        isCorrect: player.hasAnswered && player.currentAnswer === correctAnswer,
        previousScore: player.previousScore,
        newScore: player.score,
        pointChange: player.lastPointChange,
        eliminated: player.eliminated,
      });
    });

    // Envoyer les résultats à tous les joueurs
    io.to(gameId).emit("question-results", {
      results: results,
      eliminatedPlayers: eliminatedPlayers.map((p) => ({
        playerId: p.id,
        playerName: p.name,
      })),
    });

    // Vérifier si il faut terminer le jeu
    const activePlayers = room.players.filter((player) => !player.eliminated);

    if (activePlayers.length <= 1) {
      // Fin de partie par élimination
      setTimeout(() => {
        endGameWithElimination(gameId, eliminatedPlayers);
      }, 10000);
      return;
    }

    // Passer à la question suivante après 10 secondes
    room.resultsTimer = setTimeout(() => {
      sendNextQuestion(gameId);
    }, 10000);
  }

  // Nouvelle fonction pour gérer la fin de partie avec élimination
  function endGameWithElimination(gameId, eliminatedPlayers) {
    const room = rooms.get(gameId);
    if (!room) return;

    room.status = "finished";
    clearInterval(countdownInterval);
    if (room.resultsTimer) clearTimeout(room.resultsTimer);

    const activePlayers = room.players.filter((player) => !player.eliminated);
    const finalScores = room.players
      .map((player) => ({
        playerId: player.id,
        playerName: player.name,
        score: player.score,
        eliminated: player.eliminated || false,
      }))
      .sort((a, b) => {
        // Les joueurs non éliminés en premier, puis par score
        if (a.eliminated && !b.eliminated) return 1;
        if (!a.eliminated && b.eliminated) return -1;
        return b.score - a.score;
      });

    const winner = activePlayers.length > 0 ? activePlayers[0] : null;

    io.to(gameId).emit("game-ended", {
      finalScores: finalScores,
      winner: winner
        ? {
            playerId: winner.id,
            playerName: winner.name,
            score: winner.score,
          }
        : null,
      reason: "elimination",
      eliminatedPlayers: eliminatedPlayers.map((p) => ({
        playerId: p.id,
        playerName: p.name,
      })),
    });

    console.log(`Partie ${gameId} terminée par élimination`);
  }

  function endGame(gameId) {
    const room = rooms.get(gameId);
    if (!room) return;

    room.status = "finished";
    clearInterval(countdownInterval);
    if (room.resultsTimer) clearTimeout(room.resultsTimer);

    const finalScores = room.players
      .map((player) => ({
        playerId: player.id,
        playerName: player.name,
        score: player.score,
        eliminated: player.eliminated || false,
      }))
      .sort((a, b) => {
        // Les joueurs non éliminés en premier, puis par score
        if (a.eliminated && !b.eliminated) return 1;
        if (!a.eliminated && b.eliminated) return -1;
        return b.score - a.score;
      });

    const winner =
      finalScores.find((player) => !player.eliminated) || finalScores[0];

    io.to(gameId).emit("game-ended", {
      finalScores: finalScores,
      winner: winner
        ? {
            playerId: winner.playerId,
            playerName: winner.playerName,
            score: winner.score,
          }
        : null,
    });

    console.log(`Partie ${gameId} terminée`);
  }

  // Gérer la déconnexion
  socket.on("disconnect", () => {
    console.log("Client déconnecté :", socket.id);

    for (const [gameId, room] of rooms.entries()) {
      if (room.host === socket.id) {
        clearInterval(countdownInterval);
        if (room.resultsTimer) clearTimeout(room.resultsTimer);
        io.to(gameId).emit("host-disconnected");
        rooms.delete(gameId);
        console.log(`Room ${gameId} supprimée (hôte déconnecté)`);
      } else {
        const playerIndex = room.players.findIndex((p) => p.id === socket.id);
        if (playerIndex !== -1) {
          const removedPlayer = room.players.splice(playerIndex, 1)[0];
          io.to(gameId).emit("player-left", {
            playerId: socket.id,
            playerName: removedPlayer.name,
            players: room.players,
          });
        }
      }
    }
  });

  socket.on("get-room-info", (gameId) => {
    const room = rooms.get(gameId);
    if (room) {
      socket.emit("room-info", { gameId, room });
    } else {
      socket.emit("room-error", "Room introuvable");
    }
  });
});

server.listen(3001, () => {
  console.log("Serveur Socket.IO en écoute sur http://localhost:3001");
});