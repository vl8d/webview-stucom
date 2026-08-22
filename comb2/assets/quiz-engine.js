/* ============================================================
   QUIZ ENGINE — moteur générique réutilisable
   -----------------------------------------------------------
   Chaque page "Examen Blanc" fournit uniquement une config :

   QuizEngine.init({
     id: 'slug-unique-du-cours',       // sert de clé localStorage + Firestore
     title: 'Examen Blanc',
     subtitle: 'Nom du cours',
     icon: '🏛️',                       // emoji affiché en tête
     accent1: '#00E5FF',
     accent2: '#FFEA00',
     backHref: '../../index.html',      // optionnel
     backLabel: '← Retour',             // optionnel
     levelNames: {1:'Novice', 2:'Intermédiaire', 3:'Avancé', 4:'Expert', 5:'Maître'}, // optionnel
     questions: [
       { level: 1, question: '...', options: ['A','B','C'], correctAnswer: 'B', explanation: '...' },
       ...
     ]
   });

   Le moteur s'occupe de : la connexion Google obligatoire (via
   window.AuthGate, voir assets/auth.js), la construction du DOM, les
   filtres par niveau, le mode aléatoire, la barre de progression live,
   les streaks, XP, badges de score, confettis, la correction avec
   explications, l'historique des scores (synchronisé sur Firestore
   par utilisateur, avec cache local hors-ligne) et la revue des erreurs.

   Si window.AuthGate n'est pas chargé (page qui ne l'inclut pas), le
   moteur se dégrade automatiquement en mode local seul, sans gate.
   ============================================================ */

(function (global) {
    'use strict';

    function init(config) {
        const cfg = Object.assign({
            id: 'quiz',
            title: 'Examen Blanc',
            subtitle: '',
            icon: '🎓',
            accent1: '#00E5FF',
            accent2: '#FFEA00',
            backHref: null,
            backLabel: '← Retour',
            levelNames: { 1: 'Novice', 2: 'Intermédiaire', 3: 'Avancé', 4: 'Expert', 5: 'Maître' },
            questions: []
        }, config || {});

        document.documentElement.style.setProperty('--accent-1', cfg.accent1);
        document.documentElement.style.setProperty('--accent-2', cfg.accent2);

        const root = cfg.mount ? (typeof cfg.mount === 'string' ? document.querySelector(cfg.mount) : cfg.mount) : (document.getElementById('quiz-app') || document.body);

        if (!global.AuthGate) {
            // Pas de module d'authentification chargé : on démarre en local seul.
            root.innerHTML = buildSkeleton(cfg, null);
            startApp(cfg, root, null);
            return;
        }

        root.innerHTML = buildLoadingScreen(cfg);

        global.AuthGate.onReady(user => {
            if (!user) {
                renderLoginScreen(cfg, root);
                return;
            }
            root.innerHTML = buildSkeleton(cfg, user);
            startApp(cfg, root, user);
        });
    }

    function renderLoginScreen(cfg, root) {
        root.innerHTML = buildAuthScreen(cfg);
        const errBox = root.querySelector('#authError');
        wireLoginButton(root, '#googleLoginBtn', () => global.AuthGate.signInGoogle(), errBox);
        wireLoginButton(root, '#msLoginBtn', () => global.AuthGate.signInMicrosoft(), errBox);
    }

    function wireLoginButton(root, selector, signIn, errBox) {
        const btn = root.querySelector(selector);
        if (!btn) return;
        btn.addEventListener('click', () => {
            btn.disabled = true;
            errBox.textContent = '';
            signIn().catch(e => {
                errBox.textContent = authErrorMessage(e);
                btn.disabled = false;
            });
            // Le rendu se met à jour automatiquement via onAuthStateChanged (voir init()).
        });
    }

    function authErrorMessage(e) {
        const msgs = {
            'auth/popup-closed-by-user': "Fenêtre de connexion fermée avant la fin.",
            'auth/popup-blocked': "Le navigateur a bloqué la fenêtre de connexion — autorise les popups pour ce site.",
            'auth/unauthorized-domain': "Ce domaine n'est pas encore autorisé pour la connexion Google (à configurer côté Firebase)."
        };
        return msgs[e.code] || (e.message || 'Connexion impossible, réessaie.');
    }

    function startApp(cfg, root, user) {
        const storageKey = 'quizHistory_' + cfg.id + (user ? '_' + user.uid : '');
        const soundKey = 'quizSoundMuted';

        const els = {
            filters: root.querySelector('#filters'),
            quizContainer: root.querySelector('#quiz-container'),
            form: root.querySelector('#quizForm'),
            submitBtn: root.querySelector('#submitBtn'),
            finalScore: root.querySelector('#finalScore'),
            historyList: root.querySelector('#historyList'),
            progressWrap: root.querySelector('#progressWrap'),
            progressFill: root.querySelector('#progressFill'),
            progressText: root.querySelector('#progressText'),
            streakLive: root.querySelector('#streakLive'),
            secondaryActions: root.querySelector('#secondaryActions'),
            reviewBtn: root.querySelector('#reviewBtn'),
            retryBtn: root.querySelector('#retryBtn'),
            soundToggle: root.querySelector('#soundToggle'),
            statBest: root.querySelector('#statBest'),
            statRuns: root.querySelector('#statRuns'),
            statStreak: root.querySelector('#statStreak'),
            clearHistoryBtn: root.querySelector('#clearHistoryBtn'),
            randomBtn: root.querySelector('#randomBtn'),
            logoutBtn: root.querySelector('#logoutBtn')
        };

        let currentFilter = 'all';
        let currentQuestions = [];
        let startTime = null;
        let reviewMode = false;
        let historyCache = [];
        let soundMuted = localStorage.getItem(soundKey) === '1';
        updateSoundIcon();

        if (els.logoutBtn) {
            els.logoutBtn.addEventListener('click', () => {
                global.AuthGate.signOut().catch(() => {});
                // onAuthStateChanged (dans init) réaffiche automatiquement l'écran de connexion.
            });
        }

        // ---------- audio (tiny WebAudio beeps, no external files) ----------
        let audioCtx = null;
        function beep(freq, dur) {
            if (soundMuted) return;
            try {
                audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start();
                osc.stop(audioCtx.currentTime + dur);
            } catch (e) { /* ignore */ }
        }

        els.soundToggle.addEventListener('click', () => {
            soundMuted = !soundMuted;
            localStorage.setItem(soundKey, soundMuted ? '1' : '0');
            updateSoundIcon();
        });
        function updateSoundIcon() {
            els.soundToggle.textContent = soundMuted ? '🔇' : '🔊';
            els.soundToggle.classList.toggle('muted', soundMuted);
            els.soundToggle.title = soundMuted ? 'Activer le son' : 'Couper le son';
        }

        // ---------- filters ----------
        const levelsPresent = [...new Set(cfg.questions.map(q => q.level))].sort((a, b) => a - b);
        els.filters.innerHTML = '';
        const allBtn = makeFilterBtn('all', `Examen Complet (${cfg.questions.length}Q)`, true);
        els.filters.appendChild(allBtn);
        levelsPresent.forEach(lvl => {
            const label = `Lvl ${lvl} : ${cfg.levelNames[lvl] || lvl}`;
            els.filters.appendChild(makeFilterBtn(String(lvl), label, false));
        });

        function makeFilterBtn(level, label, active) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'filter-btn' + (active ? ' active' : '');
            btn.dataset.level = level;
            btn.textContent = label;
            btn.addEventListener('click', () => {
                root.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFilter = level;
                buildQuiz(level, false);
            });
            return btn;
        }

        els.randomBtn.addEventListener('click', () => {
            root.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            currentFilter = 'random';
            buildQuiz('random', true);
        });

        // ---------- build quiz ----------
        function shuffle(arr) {
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        }

        function buildQuiz(filter, random) {
            reviewMode = false;
            els.quizContainer.innerHTML = '';
            els.finalScore.style.display = 'none';
            els.finalScore.innerHTML = '';
            els.submitBtn.disabled = false;
            els.submitBtn.style.display = 'block';
            els.submitBtn.textContent = 'Corriger mes réponses';
            els.secondaryActions.style.display = 'none';
            els.progressWrap.style.display = 'block';

            if (random) {
                currentQuestions = shuffle(cfg.questions).slice(0, Math.min(10, cfg.questions.length));
            } else {
                currentQuestions = filter === 'all' ? cfg.questions.slice() : cfg.questions.filter(q => q.level == filter);
            }

            currentQuestions.forEach((q, index) => {
                const block = document.createElement('div');
                block.className = `question-block diff-${q.level}`;
                block.id = `q${index}`;

                let html = `
                    <div class="badge">Niveau ${q.level}</div>
                    <div class="q-number">${index + 1} / ${currentQuestions.length}</div>
                    <div class="question-text">${escapeHtml(q.question)}</div>
                    <div class="options">
                `;

                shuffle(q.options).forEach((option) => {
                    html += `<label><input type="radio" name="q${index}" value="${escapeAttr(option)}"> ${escapeHtml(option)}</label>`;
                });

                html += `</div><div class="feedback"></div><div class="explanation">${q.explanation ? escapeHtml(q.explanation) : ''}</div>`;
                block.innerHTML = html;
                els.quizContainer.appendChild(block);
            });

            updateProgress();
            window.scrollTo({ top: els.quizContainer.offsetTop - 20, behavior: 'smooth' });
            startTime = Date.now();
        }

        els.quizContainer.addEventListener('change', (e) => {
            if (e.target && e.target.type === 'radio') updateProgress();
        });

        function updateProgress() {
            const total = currentQuestions.length;
            if (!total) {
                els.progressWrap.style.display = 'none';
                return;
            }
            const answered = new Set();
            currentQuestions.forEach((q, i) => {
                if (els.quizContainer.querySelector(`input[name="q${i}"]:checked`)) answered.add(i);
            });
            const pct = Math.round((answered.size / total) * 100);
            els.progressFill.style.width = pct + '%';
            els.progressText.textContent = `${answered.size} / ${total} répondu${answered.size > 1 ? 's' : ''}`;
        }

        // ---------- submit / correction ----------
        els.form.addEventListener('submit', function (e) {
            e.preventDefault();
            let score = 0;
            let streak = 0;
            let bestStreak = 0;

            currentQuestions.forEach((q, index) => {
                const selectedOption = els.quizContainer.querySelector(`input[name="q${index}"]:checked`);
                const questionBlock = document.getElementById(`q${index}`);
                const feedbackElement = questionBlock.querySelector('.feedback');

                questionBlock.classList.remove('is-correct', 'is-wrong');

                const isCorrect = selectedOption && selectedOption.value === q.correctAnswer;
                if (isCorrect) {
                    score++;
                    streak++;
                    bestStreak = Math.max(bestStreak, streak);
                    questionBlock.classList.add('is-correct');
                    feedbackElement.innerHTML = '✓ BIEN JOUÉ';
                } else {
                    streak = 0;
                    questionBlock.classList.add('is-wrong');
                    feedbackElement.innerHTML = `✗ ${selectedOption ? 'ERREUR' : 'SANS RÉPONSE'}<br><span style="font-weight:normal; font-size:0.9em; margin-top:5px; display:block;">Réponse attendue : <i>${escapeHtml(q.correctAnswer)}</i></span>`;
                }

                questionBlock.querySelectorAll('.options label').forEach(label => {
                    const input = label.querySelector('input');
                    if (input.value === q.correctAnswer) label.classList.add('opt-correct');
                    else if (input === selectedOption) label.classList.add('opt-wrong');
                });

                questionBlock.querySelectorAll('input').forEach(input => input.disabled = true);
            });

            const total = currentQuestions.length;
            const pct = total ? Math.round((score / total) * 100) : 0;
            const elapsedSec = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

            renderScore(score, total, pct, elapsedSec, bestStreak);

            els.submitBtn.disabled = true;
            els.submitBtn.textContent = 'Correction Terminée';
            els.secondaryActions.style.display = 'flex';
            els.progressFill.style.width = '100%';
            els.progressText.textContent = `${total} / ${total} corrigé${total > 1 ? 's' : ''}`;

            beep(pct >= 70 ? 880 : 220, 0.18);
            if (pct >= 80) launchConfetti();
            if (pct === 100) toast('🏆 SANS FAUTE !');
            else if (bestStreak >= 5) toast(`🔥 Série de ${bestStreak} bonnes réponses !`);

            window.scrollTo({ top: els.finalScore.offsetTop - 100, behavior: 'smooth' });
            saveScore(score, total, currentFilter, pct);
        });

        function badgeForPct(pct) {
            if (pct === 100) return { label: '🏆 Sans-faute', color: '#c084fc' };
            if (pct >= 90) return { label: '🥇 Maître', color: '#EFBF04' };
            if (pct >= 70) return { label: '🥈 Bien joué', color: '#4ade80' };
            if (pct >= 50) return { label: '🥉 Pas mal', color: '#fb923c' };
            return { label: '📚 À revoir', color: '#f87171' };
        }

        function renderScore(score, total, pct, elapsedSec, bestStreak) {
            const b = badgeForPct(pct);
            const mins = Math.floor(elapsedSec / 60);
            const secs = elapsedSec % 60;
            const timeStr = `${mins}m${secs.toString().padStart(2, '0')}s`;
            els.finalScore.innerHTML = `
                <span class="score-big">SCORE : ${score} / ${total} (${pct}%)</span>
                <span class="score-badge" style="background:${b.color}22; color:${b.color}; border:1px solid ${b.color}66;">${b.label}</span>
                <div class="score-meta">⏱ ${timeStr} · 🔥 meilleure série : ${bestStreak}</div>
            `;
            els.finalScore.style.display = 'block';
        }

        // ---------- review mistakes ----------
        els.reviewBtn.addEventListener('click', () => {
            reviewMode = !reviewMode;
            els.reviewBtn.textContent = reviewMode ? '👁️ Voir toutes les questions' : '🔍 Revoir mes erreurs';
            els.quizContainer.querySelectorAll('.question-block').forEach(block => {
                block.classList.toggle('hide-when-reviewing', reviewMode);
            });
            const firstWrong = els.quizContainer.querySelector('.is-wrong');
            if (reviewMode && firstWrong) firstWrong.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        els.retryBtn.addEventListener('click', () => {
            buildQuiz(currentFilter, currentFilter === 'random');
        });

        // ---------- history (localStorage cache + sync Firestore par utilisateur) ----------
        function readLocalHistory() {
            try { return JSON.parse(localStorage.getItem(storageKey)) || []; }
            catch (e) { return []; }
        }
        function writeLocalHistory(history) {
            localStorage.setItem(storageKey, JSON.stringify(history));
        }

        function saveScore(score, total, level, pct) {
            const date = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const modeLabel = level === 'random' ? '🎲 Aléatoire' : (cfg.levelNames[level] || 'Examen Complet');
            const entry = { score, total, date, mode: modeLabel, pct };

            historyCache.push(entry);
            if (historyCache.length > 12) historyCache.shift();
            writeLocalHistory(historyCache);
            displayHistory();

            if (user && global.AuthGate) {
                global.AuthGate.scoresCollection(user.uid, cfg.id).add({
                    course: cfg.id,
                    score, total, pct,
                    mode: modeLabel,
                    date,
                    ts: firebase.firestore.FieldValue.serverTimestamp()
                }).catch(err => console.warn('Sync Firestore échouée (score gardé en local) :', err));
            }
        }

        function displayHistory() {
            const history = historyCache;
            els.historyList.innerHTML = '';

            if (history.length === 0) {
                els.historyList.innerHTML = '<li class="empty-state" style="width:100%; justify-content:center;">Commence un test pour voir tes résultats ici.</li>';
                els.statBest.textContent = '–';
                els.statRuns.textContent = '0';
                els.statStreak.textContent = '–';
                return;
            }

            [...history].reverse().forEach(item => {
                const li = document.createElement('li');
                const pct = item.pct !== undefined ? item.pct : Math.round((item.score / item.total) * 100);
                const b = badgeForPct(pct);
                li.innerHTML = `
                    <div>
                        <span class="hist-date">${item.date}</span>
                        <span class="hist-mode">${item.mode}</span>
                    </div>
                    <div style="text-align:right;">
                        <span class="hist-score">${item.score} / ${item.total}</span>
                        <div style="font-size:0.7rem; color:${b.color}; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${b.label}</div>
                    </div>
                `;
                els.historyList.appendChild(li);
            });

            const best = Math.max(...history.map(h => h.pct !== undefined ? h.pct : Math.round((h.score / h.total) * 100)));
            els.statBest.textContent = best + '%';
            els.statRuns.textContent = history.length;

            let curStreak = 0;
            for (let i = history.length - 1; i >= 0; i--) {
                const p = history[i].pct !== undefined ? history[i].pct : Math.round((history[i].score / history[i].total) * 100);
                if (p >= 50) curStreak++; else break;
            }
            els.statStreak.textContent = curStreak;
        }

        function loadHistory() {
            historyCache = readLocalHistory();
            displayHistory();

            if (!user || !global.AuthGate) return;
            global.AuthGate.scoresCollection(user.uid, cfg.id)
                .orderBy('ts', 'desc')
                .limit(12)
                .get()
                .then(snap => {
                    const serverHistory = [];
                    snap.forEach(doc => {
                        const d = doc.data();
                        serverHistory.push({ score: d.score, total: d.total, date: d.date, mode: d.mode, pct: d.pct });
                    });
                    serverHistory.reverse(); // du plus ancien au plus récent, comme historyCache
                    if (serverHistory.length) {
                        historyCache = serverHistory;
                        writeLocalHistory(historyCache);
                        displayHistory();
                    }
                })
                .catch(err => console.warn('Lecture Firestore échouée (historique local conservé) :', err));
        }

        els.clearHistoryBtn.addEventListener('click', () => {
            if (!confirm('Effacer tout ton historique de scores pour ce cours ?')) return;
            historyCache = [];
            localStorage.removeItem(storageKey);
            displayHistory();
            if (user && global.AuthGate) {
                global.AuthGate.scoresCollection(user.uid, cfg.id).get()
                    .then(snap => {
                        const batch = global.AuthGate.getDb().batch();
                        snap.forEach(doc => batch.delete(doc.ref));
                        return batch.commit();
                    })
                    .catch(err => console.warn('Suppression Firestore échouée :', err));
            }
        });

        // ---------- toasts ----------
        function toast(msg) {
            const layer = document.getElementById('toastLayer');
            const t = document.createElement('div');
            t.className = 'toast';
            t.textContent = msg;
            layer.appendChild(t);
            setTimeout(() => t.remove(), 2700);
        }

        // ---------- confetti (vanilla, no deps) ----------
        function launchConfetti() {
            const canvas = document.getElementById('confettiCanvas');
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            const ctx = canvas.getContext('2d');
            const colors = [cfg.accent1, cfg.accent2, '#4ade80', '#c084fc', '#fb923c'];
            const pieces = Array.from({ length: 140 }, () => ({
                x: Math.random() * canvas.width,
                y: -20 - Math.random() * canvas.height * 0.5,
                w: 6 + Math.random() * 6,
                h: 8 + Math.random() * 8,
                color: colors[Math.floor(Math.random() * colors.length)],
                speedY: 2 + Math.random() * 4,
                speedX: -2 + Math.random() * 4,
                rot: Math.random() * 360,
                rotSpeed: -8 + Math.random() * 16
            }));
            let frame = 0;
            const maxFrames = 150;
            function animate() {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                pieces.forEach(p => {
                    p.x += p.speedX;
                    p.y += p.speedY;
                    p.rot += p.rotSpeed;
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.rot * Math.PI / 180);
                    ctx.fillStyle = p.color;
                    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.restore();
                });
                frame++;
                if (frame < maxFrames) requestAnimationFrame(animate);
                else ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            animate();
        }

        // ---------- utils ----------
        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
        function escapeAttr(str) { return escapeHtml(str); }

        // ---------- init ----------
        loadHistory();
        buildQuiz('all', false);
    }

    function buildLoadingScreen(cfg) {
        return `
            <div class="container">
                <div class="auth-screen">
                    <span class="quiz-icon">${cfg.icon}</span>
                    <div class="auth-spinner" style="margin-top:20px;"></div>
                </div>
            </div>
        `;
    }

    function authButtonsHtml() {
        return `
            <div class="auth-buttons">
                <button type="button" id="googleLoginBtn" class="provider-btn">
                    <svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12s5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24s8.955,20,20,20s20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/><path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/></svg>
                    Google
                </button>
                <button type="button" id="msLoginBtn" class="provider-btn">
                    <svg viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
                    Microsoft
                </button>
            </div>
        `;
    }

    function buildAuthScreen(cfg) {
        return `
            <div class="container">
                <div class="auth-screen">
                    <span class="quiz-icon">${cfg.icon}</span>
                    <h1>Examens Blancs</h1>
                    ${authButtonsHtml()}
                    <div class="auth-error" id="authError"></div>
                    <p class="auth-legal">Accès strictement privé, réservé aux personnes autorisées.</p>
                </div>
            </div>
        `;
    }

    function buildSkeleton(cfg, user) {
        const backLink = cfg.backHref ? `<a class="back-link" href="${cfg.backHref}">${cfg.backLabel}</a>` : '<span></span>';
        const userBar = user ? `
            <div class="user-bar">
                ${user.photoURL ? `<img src="${user.photoURL}" alt="">` : ''}
                <span>${user.displayName || user.email || ''}</span>
                <button type="button" id="logoutBtn">Se déconnecter</button>
            </div>
        ` : '<span></span>';
        return `
            <div id="toastLayer"></div>
            <canvas id="confettiCanvas"></canvas>
            <div class="container">
                <header class="quiz-header">
                    <div class="top-bar">
                        ${backLink}
                        ${userBar}
                        <button type="button" id="soundToggle" class="sound-toggle" title="Couper le son">🔊</button>
                    </div>
                    <span class="quiz-icon">${cfg.icon}</span>
                    <h1 class="quiz-title"><span>${cfg.title.split(' ')[0]}</span> ${cfg.title.split(' ').slice(1).join(' ')}</h1>
                    <h2 class="quiz-subtitle">${cfg.subtitle}</h2>

                    <div class="stats-strip">
                        <div class="stat-card"><span class="stat-value" id="statBest">–</span><span class="stat-label">Meilleur score</span></div>
                        <div class="stat-card"><span class="stat-value" id="statRuns">0</span><span class="stat-label">Tentatives</span></div>
                        <div class="stat-card"><span class="stat-value" id="statStreak">–</span><span class="stat-label">Série ≥ 50%</span></div>
                    </div>
                </header>

                <div class="filters" id="filters"></div>
                <div class="mode-row">
                    <button type="button" id="randomBtn" class="random-btn">🎲 10 Questions Surprises</button>
                </div>

                <div class="progress-wrap" id="progressWrap">
                    <div class="progress-info">
                        <span id="progressText">0 / 0 répondu</span>
                        <span class="streak-live" id="streakLive"></span>
                    </div>
                    <div class="progress-bar-track"><div class="progress-bar-fill" id="progressFill"></div></div>
                </div>

                <form id="quizForm">
                    <div id="quiz-container"></div>
                    <button type="submit" class="btn-submit" id="submitBtn">Corriger mes réponses</button>
                    <div class="secondary-actions" id="secondaryActions" style="display:none;">
                        <button type="button" id="reviewBtn">🔍 Revoir mes erreurs</button>
                        <button type="button" id="retryBtn">🔁 Recommencer ce mode</button>
                    </div>
                </form>

                <div id="finalScore"></div>

                <div class="history-section">
                    <h3>Dashboard des Scores</h3>
                    <ul id="historyList"></ul>
                    <button type="button" class="clear-history-btn" id="clearHistoryBtn">Effacer l'historique</button>
                </div>

                <footer class="quiz-footer">stucom · examens blancs interactifs</footer>
            </div>
        `;
    }

    global.QuizEngine = { init, authButtonsHtml, wireLoginButton, authErrorMessage };
})(window);
