/* ============================================================
   FLASHCARD ENGINE — moteur de cartes mémoire réutilisable
   -----------------------------------------------------------
   FlashcardEngine.init({
     id: 'slug-unique-du-cours',
     title: 'Vocabulaire',
     subtitle: 'Nom du cours',
     icon: '🗂️',
     backHref: '../index.html',
     decks: [
       { id: 'salutations', label: 'Salutations', cards: [ { front: 'bonjour', back: 'hallo' }, ... ] },
       ...
     ],
     frontLabel: 'Français',
     backLabel: 'Nederlands'
   });

   Système de répétition espacée simplifié (méthode Leitner, 5 casiers) :
   - « Je savais » → la carte monte d'un casier (revue moins souvent)
   - « Je ne savais pas » → la carte retombe au casier 1 (revue très vite)
   Le mode « Révision intelligente » priorise les cartes des casiers bas
   et les moins révisées récemment. Connexion Google/Microsoft obligatoire
   (via window.AuthGate) ; la progression est sauvegardée par utilisateur
   dans Firestore (avec cache localStorage hors-ligne).
   ============================================================ */

(function (global) {
    'use strict';

    function init(config) {
        const cfg = Object.assign({
            id: 'flashcards',
            title: 'Cartes Flash',
            subtitle: '',
            icon: '🗂️',
            backHref: null,
            backLabel: '← Retour',
            frontLabel: 'Français',
            backLabel2: 'Nederlands',
            decks: []
        }, config || {});

        const root = cfg.mount ? (typeof cfg.mount === 'string' ? document.querySelector(cfg.mount) : cfg.mount) : (document.getElementById('quiz-app') || document.body);

        if (!global.AuthGate) {
            root.innerHTML = buildLoadingScreen(cfg);
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
        const gWire = window.QuizEngine ? window.QuizEngine.wireLoginButton : null;
        if (gWire) {
            gWire(root, '#googleLoginBtn', () => global.AuthGate.signInGoogle(), errBox);
            gWire(root, '#msLoginBtn', () => global.AuthGate.signInMicrosoft(), errBox);
        }
    }

    function buildLoadingScreen(cfg) {
        return `<div class="container"><div class="auth-screen"><span class="quiz-icon">${cfg.icon}</span><div class="auth-spinner" style="margin-top:20px;"></div></div></div>`;
    }

    function buildAuthScreen(cfg) {
        const buttons = window.QuizEngine ? window.QuizEngine.authButtonsHtml() : '';
        return `
            <div class="container">
                <div class="auth-screen">
                    <span class="quiz-icon">${cfg.icon}</span>
                    <h1>Examens Blancs</h1>
                    ${buttons}
                    <div class="auth-error" id="authError"></div>
                    <p class="auth-legal">Accès strictement privé, réservé aux personnes autorisées.</p>
                </div>
            </div>
        `;
    }

    function startApp(cfg, root, user) {
        const storageKey = 'flashcards_' + cfg.id + (user ? '_' + user.uid : '');
        let cardStats = {}; // { "deckId:idx": { box, lastSeen } }
        let currentDeck = null;
        let queue = [];
        let qi = 0;
        let flipped = false;
        let direction = 'front-back'; // or 'back-front'
        let sessionRight = 0, sessionSeen = 0;

        const els = {
            deckPicker: root.querySelector('#deckPicker'),
            directionBtn: root.querySelector('#directionBtn'),
            cardWrap: root.querySelector('#cardWrap'),
            cardInner: root.querySelector('#cardInner'),
            cardFront: root.querySelector('#cardFront'),
            cardBack: root.querySelector('#cardBack'),
            rateRow: root.querySelector('#rateRow'),
            progressText: root.querySelector('#fcProgressText'),
            mastery: root.querySelector('#fcMastery'),
            progressFill: root.querySelector('#fcProgressFill'),
            deckStats: root.querySelector('#deckStats'),
            logoutBtn: root.querySelector('#logoutBtn'),
            emptyState: root.querySelector('#fcEmpty')
        };

        if (els.logoutBtn) {
            els.logoutBtn.addEventListener('click', () => { global.AuthGate.signOut().catch(() => {}); });
        }

        function cardKey(deckId, idx) { return deckId + ':' + idx; }

        function loadStats() {
            try { cardStats = JSON.parse(localStorage.getItem(storageKey)) || {}; }
            catch (e) { cardStats = {}; }
            if (user && global.AuthGate) {
                const db = global.AuthGate.getDb();
                if (db) {
                    db.collection('examBlanc').doc(user.uid).collection('courses').doc(cfg.id)
                        .collection('flashcards').doc('stats').get()
                        .then(doc => {
                            if (doc.exists && doc.data().cards) {
                                cardStats = doc.data().cards;
                                localStorage.setItem(storageKey, JSON.stringify(cardStats));
                                renderDeckPicker();
                            }
                        })
                        .catch(err => console.warn('Lecture Firestore (flashcards) échouée :', err));
                }
            }
        }

        function saveStats() {
            localStorage.setItem(storageKey, JSON.stringify(cardStats));
            if (user && global.AuthGate) {
                const db = global.AuthGate.getDb();
                if (db) {
                    db.collection('examBlanc').doc(user.uid).collection('courses').doc(cfg.id)
                        .collection('flashcards').doc('stats').set({ cards: cardStats }, { merge: false })
                        .catch(err => console.warn('Sync Firestore (flashcards) échouée :', err));
                }
            }
        }

        function boxOf(deckId, idx) {
            const s = cardStats[cardKey(deckId, idx)];
            return s ? s.box : 1;
        }

        function renderDeckPicker() {
            els.deckPicker.innerHTML = '';
            const allBtn = makeDeckBtn('__all', `Toutes les cartes (${cfg.decks.reduce((a, d) => a + d.cards.length, 0)})`);
            els.deckPicker.appendChild(allBtn);
            const smartBtn = makeDeckBtn('__smart', '🧠 Révision intelligente');
            els.deckPicker.appendChild(smartBtn);
            cfg.decks.forEach(d => {
                els.deckPicker.appendChild(makeDeckBtn(d.id, `${d.label} (${d.cards.length})`));
            });
        }

        function makeDeckBtn(id, label) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'filter-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => {
                root.querySelectorAll('#deckPicker .filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                startDeck(id);
            });
            return btn;
        }

        function shuffle(arr) {
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        }

        // Trie par « boîte » Leitner croissante (les cartes les moins connues
        // d'abord), quel que soit le mode où la carte a été apprise — le
        // classement est mélangé au préalable pour varier l'ordre entre
        // cartes d'une même boîte, puis trié de façon stable par boîte.
        function sortByKnowledge(pool) {
            const shuffled = shuffle(pool);
            return shuffled.sort((a, b) => {
                const ba = boxOf(a.deckId, a.idx), bb = boxOf(b.deckId, b.idx);
                if (ba !== bb) return ba - bb;
                const la = (cardStats[cardKey(a.deckId, a.idx)] || {}).lastSeen || 0;
                const lb = (cardStats[cardKey(b.deckId, b.idx)] || {}).lastSeen || 0;
                return la - lb;
            });
        }

        function startDeck(deckId) {
            currentDeck = deckId;
            sessionRight = 0; sessionSeen = 0;
            let pool = [];
            if (deckId === '__all') {
                cfg.decks.forEach(d => d.cards.forEach((c, i) => pool.push({ deckId: d.id, idx: i, card: c })));
                pool = sortByKnowledge(pool);
            } else if (deckId === '__smart') {
                cfg.decks.forEach(d => d.cards.forEach((c, i) => pool.push({ deckId: d.id, idx: i, card: c })));
                pool = sortByKnowledge(pool).slice(0, Math.min(20, pool.length));
            } else {
                const deck = cfg.decks.find(d => d.id === deckId);
                pool = sortByKnowledge((deck ? deck.cards : []).map((c, i) => ({ deckId, idx: i, card: c })));
            }
            queue = pool;
            qi = 0;
            els.emptyState.style.display = queue.length ? 'none' : 'block';
            els.cardWrap.style.display = queue.length ? 'block' : 'none';
            els.rateRow.style.display = queue.length ? 'flex' : 'none';
            showCard();
        }

        function showCard() {
            if (qi >= queue.length) {
                els.cardFront.textContent = '🎉';
                els.cardBack.textContent = '';
                els.cardInner.classList.remove('flipped');
                flipped = false;
                els.progressText.textContent = `Terminé — ${sessionRight}/${sessionSeen} connues`;
                els.progressFill.style.width = '100%';
                els.rateRow.style.display = 'none';
                els.mastery.textContent = '';
                return;
            }
            const item = queue[qi];
            const front = direction === 'front-back' ? item.card.front : item.card.back;
            const back = direction === 'front-back' ? item.card.back : item.card.front;
            els.cardFront.textContent = front;
            els.cardBack.textContent = back;
            els.cardInner.classList.remove('flipped');
            flipped = false;
            const pct = Math.round((qi / queue.length) * 100);
            els.progressFill.style.width = pct + '%';
            els.progressText.textContent = `${qi + 1} / ${queue.length}`;
            els.mastery.textContent = masteryDots(boxOf(item.deckId, item.idx));
        }

        // Reflète la boîte Leitner de la carte (1 à 5) sous forme de puces —
        // visible quel que soit le mode (thème, toutes les cartes, révision
        // intelligente) puisque la boîte est partagée par carte, pas par mode.
        function masteryDots(box) {
            return '●'.repeat(box) + '○'.repeat(5 - box);
        }

        els.cardWrap.addEventListener('click', () => {
            if (qi >= queue.length) return;
            flipped = !flipped;
            els.cardInner.classList.toggle('flipped', flipped);
        });

        els.directionBtn.addEventListener('click', () => {
            direction = direction === 'front-back' ? 'back-front' : 'front-back';
            els.directionBtn.textContent = direction === 'front-back'
                ? `${cfg.frontLabel} → ${cfg.backLabel2}`
                : `${cfg.backLabel2} → ${cfg.frontLabel}`;
            if (currentDeck) showCard();
        });

        els.rateRow.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                if (qi >= queue.length) return;
                const item = queue[qi];
                const known = btn.dataset.rate === 'known';
                const key = cardKey(item.deckId, item.idx);
                const prevBox = boxOf(item.deckId, item.idx);
                const newBox = known ? Math.min(5, prevBox + 1) : 1;
                cardStats[key] = { box: newBox, lastSeen: Date.now() };
                sessionSeen++;
                if (known) sessionRight++;
                saveStats();
                qi++;
                showCard();
            });
        });

        loadStats();
        renderDeckPicker();
        els.cardFront.textContent = '👋';
        els.cardBack.textContent = '';
        els.progressText.textContent = 'Choisis un thème pour commencer';
    }

    function buildSkeleton(cfg, user) {
        const backLink = cfg.backHref ? `<a class="back-link" href="${cfg.backHref}">${cfg.backLabel}</a>` : '<span></span>';
        const userBar = user ? `
            <div class="user-bar">
                ${user.photoURL ? `<img src="${user.photoURL}" alt="">` : ''}
                <span>${escapeHtml(user.displayName || user.email || '')}</span>
                <button type="button" id="logoutBtn">Se déconnecter</button>
            </div>
        ` : '<span></span>';
        return `
            <div class="container">
                <header class="quiz-header">
                    <div class="top-bar">
                        ${backLink}
                        ${userBar}
                    </div>
                    <span class="quiz-icon">${cfg.icon}</span>
                    <h1 class="quiz-title"><span>${cfg.title.split(' ')[0]}</span> ${cfg.title.split(' ').slice(1).join(' ')}</h1>
                    <h2 class="quiz-subtitle">${cfg.subtitle}</h2>
                </header>

                <div class="filters" id="deckPicker"></div>
                <div class="mode-row">
                    <button type="button" id="directionBtn" class="random-btn">${cfg.frontLabel} → ${cfg.backLabel2}</button>
                </div>

                <div class="fc-progress-wrap">
                    <span id="fcProgressText">Choisis un thème pour commencer</span>
                    <span id="fcMastery" class="fc-mastery"></span>
                    <div class="progress-bar-track"><div class="progress-bar-fill" id="fcProgressFill"></div></div>
                </div>

                <div id="fcEmpty" class="empty-state" style="display:none;">Ce thème ne contient aucune carte.</div>

                <div class="fc-card-wrap" id="cardWrap">
                    <div class="fc-card-inner" id="cardInner">
                        <div class="fc-card-face fc-card-front" id="cardFront">👋</div>
                        <div class="fc-card-face fc-card-back" id="cardBack"></div>
                    </div>
                </div>
                <p class="fc-hint">Touche la carte pour retourner, puis évalue-toi.</p>

                <div class="fc-rate-row" id="rateRow" style="display:none;">
                    <button type="button" data-rate="unknown" class="fc-rate fc-rate--no">😵 Je ne savais pas</button>
                    <button type="button" data-rate="known" class="fc-rate fc-rate--yes">✅ Je savais</button>
                </div>

                <footer class="quiz-footer">stucom · examens blancs interactifs</footer>
            </div>
        `;
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    global.FlashcardEngine = { init };
})(window);
