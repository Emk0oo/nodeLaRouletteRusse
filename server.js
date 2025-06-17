import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Stockage des rooms et des joueurs
const rooms = new Map();

// Questions d'exemple
const questions = [
  {
    id: 1,
    question: "Quelle est la capitale de la France ?",
    options: ["Paris", "Londres", "Berlin", "Madrid"],
    correctAnswer: 0
  },
  {
    id: 2,
    question: "Combien font 2 + 2 ?",
    options: ["3", "4", "5", "6"],
    correctAnswer: 1
  },
  {
    id: 3,
    question: "Quelle est la couleur du ciel ?",
    options: ["Rouge", "Vert", "Bleu", "Jaune"],
    correctAnswer: 2
  },
  {
    id: 4,
    question: "Combien y a-t-il de jours dans une semaine ?",
    options: ["5", "6", "7", "8"],
    correctAnswer: 2
  },
  {
    id: 5,
    question: "Quel est le plus grand océan du monde ?",
    options: ["Atlantique", "Pacifique", "Indien", "Arctique"],
    correctAnswer: 1
  }
];

io.on("connection", (socket) => {
  console.log("Client connecté :", socket.id);

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
      questions: [...questions],
      playerAnswers: new Map(),
      questionTimer: null,
      resultsTimer: null,
      timeRemaining: 20,
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
      score: 7, // Score initial
      previousScore: 7,
      hasAnswered: false,
      currentAnswer: null,
      lastPointChange: 0,
      joinedAt: new Date(),
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

    console.log(`Partie ${gameId} démarrée avec ${room.players.length} joueurs`);
  });

  // Recevoir une réponse
  socket.on("submit-answer", ({ gameId, answer }) => {
    const room = rooms.get(gameId);
    if (!room || room.status !== "playing") return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hasAnswered) return;

    player.hasAnswered = true;
    player.currentAnswer = answer;

    // Notifier tous les clients qu'un joueur a répondu
    io.to(gameId).emit("player-answered", {
      playerId: player.id,
      playerName: player.name,
      totalAnswered: room.players.filter(p => p.hasAnswered).length,
      totalPlayers: room.players.length
    });

    console.log(`${player.name} a répondu: ${answer}`);
  });

  // Timer pour les questions
  let countdownInterval;
  
  function sendNextQuestion(gameId) {
    const room = rooms.get(gameId);
    if (!room) return;

    room.currentQuestionIndex++;

    if (room.currentQuestionIndex >= room.questions.length) {
      endGame(gameId);
      return;
    }

    // Réinitialiser l'état des joueurs
    room.players.forEach(player => {
      player.hasAnswered = false;
      player.currentAnswer = null;
      player.previousScore = player.score;
      player.lastPointChange = 0;
    });

    const currentQuestion = room.questions[room.currentQuestionIndex];
    room.timeRemaining = 20;

    // Envoyer la question
    io.to(gameId).emit("new-question", {
      question: currentQuestion.question,
      options: currentQuestion.options,
      questionNumber: room.currentQuestionIndex + 1,
      totalQuestions: room.questions.length,
      timeRemaining: 20
    });

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

    const currentQuestion = room.questions[room.currentQuestionIndex];
    const correctAnswer = currentQuestion.correctAnswer;

    // Calculer les scores
    room.players.forEach(player => {
      if (player.hasAnswered && player.currentAnswer === correctAnswer) {
        player.score += 1;
        player.lastPointChange = 1;
      } else {
        player.score = Math.max(0, player.score - 1);
        player.lastPointChange = -1;
      }
    });

    // Préparer les résultats
    const results = room.players.map(player => ({
      playerId: player.id,
      playerName: player.name,
      answered: player.hasAnswered,
      answer: player.currentAnswer,
      isCorrect: player.hasAnswered && player.currentAnswer === correctAnswer,
      previousScore: player.previousScore,
      newScore: player.score,
      pointChange: player.lastPointChange
    }));

    // Envoyer les résultats
    io.to(gameId).emit("question-results", {
      correctAnswer: correctAnswer,
      results: results
    });

    // Attendre 10 secondes avant la prochaine question
    room.resultsTimer = setTimeout(() => {
      sendNextQuestion(gameId);
    }, 10000);
  }

  function endGame(gameId) {
    const room = rooms.get(gameId);
    if (!room) return;

    room.status = "finished";
    clearInterval(countdownInterval);
    if (room.resultsTimer) clearTimeout(room.resultsTimer);

    const finalScores = room.players
      .map(player => ({
        playerId: player.id,
        playerName: player.name,
        score: player.score
      }))
      .sort((a, b) => b.score - a.score);

    io.to(gameId).emit("game-ended", {
      finalScores: finalScores,
      winner: finalScores[0]
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