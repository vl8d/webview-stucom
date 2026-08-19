/* ============================================================
   QUIZ ENGINE — moteur générique réutilisable
   -----------------------------------------------------------
   Chaque page "Examen Blanc" fournit uniquement une config :

   QuizEngine.init({
     id: 'slug-unique-du-cours',       // sert de clé localStorage
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

   Le moteur s'occupe de : construction du DOM, filtres par niveau,
   mode aléatoire, barre de progression live, streaks, XP, badges de
   score, confetti, correction avec explications, historique des
   scores persistant (par cours) et revue des erreurs.
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

        const storageKey = 'quizHistory_' + cfg.id;
        const soundKey = 'quizSoundMuted';

        const root = document.getElementById('quiz-app') || document.body;
        root.innerHTML = buildSkeleton(cfg);

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
            randomBtn: root.querySelector('#randomBtn')
        };

        let currentFilter = 'all';
        let currentQuestions = [];
        let startTime = null;
        let reviewMode = false;
        let soundMuted = localStorage.getItem(soundKey) === '1';
        updateSoundIcon();

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
            const count = cfg.questions.filter(q => q.level === lvl).length;
            const label = `Lvl ${lvl} : ${cfg.levelNames[lvl] || lvl}`;
            els.filters.appendChild(makeFilterBtn(String(lvl), label, false, count));
        });

        function makeFilterBtn(level, label, active, count) {
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

                q.options.forEach((option, oi) => {
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
            if (pct === 100) return { label: '🏆 Sans-faute', color: '#D500F9' };
            if (pct >= 90) return { label: '🥇 Maître', color: '#FFD700' };
            if (pct >= 70) return { label: '🥈 Bien joué', color: '#00E676' };
            if (pct >= 50) return { label: '🥉 Pas mal', color: '#FF9100' };
            return { label: '📚 À revoir', color: '#FF1744' };
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

        // ---------- history ----------
        function saveScore(score, total, level, pct) {
            const history = JSON.parse(localStorage.getItem(storageKey)) || [];
            const date = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const modeLabel = level === 'random' ? '🎲 Aléatoire' : (cfg.levelNames[level] || 'Examen Complet');
            history.push({ score, total, date, mode: modeLabel, pct });
            if (history.length > 12) history.shift();
            localStorage.setItem(storageKey, JSON.stringify(history));
            displayHistory();
        }

        function displayHistory() {
            const history = JSON.parse(localStorage.getItem(storageKey)) || [];
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

        els.clearHistoryBtn.addEventListener('click', () => {
            if (confirm('Effacer tout ton historique de scores pour ce cours ?')) {
                localStorage.removeItem(storageKey);
                displayHistory();
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
            const colors = [cfg.accent1, cfg.accent2, '#00E676', '#D500F9', '#FF9100'];
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
        displayHistory();
        buildQuiz('all', false);
    }

    function buildSkeleton(cfg) {
        const backLink = cfg.backHref ? `<a class="back-link" href="${cfg.backHref}">${cfg.backLabel}</a>` : '<span></span>';
        return `
            <div id="toastLayer"></div>
            <canvas id="confettiCanvas"></canvas>
            <div class="container">
                <header class="quiz-header">
                    <div class="top-bar">
                        ${backLink}
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

    global.QuizEngine = { init };
})(window);
