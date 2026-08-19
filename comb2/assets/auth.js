/* ============================================================
   AUTH GATE — connexion Google partagée (Firebase Auth + Firestore)
   -----------------------------------------------------------
   Réutilise le projet Firebase déjà en place pour mindmap.stucom.tech
   (mêmes identifiants publics — l'authentification Firebase repose sur
   les règles de sécurité côté serveur, pas sur le secret de la clé API).

   Toutes les données de cette plateforme vivent sous la collection
   top-level "examBlanc" pour ne jamais entrer en collision avec les
   données de mindmap ("maps").

   Chaque page qui utilise ce module doit d'abord charger, dans l'ordre :
     <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
     <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
     <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
     <script src="../../assets/auth.js"></script>
   ============================================================ */

(function (global) {
    'use strict';

    const firebaseConfig = {
        apiKey: "AIzaSyDsg8x8VM0fQ9BluC4je7c_bVG9K9EopGs",
        authDomain: "stucom-mindmap.firebaseapp.com",
        projectId: "stucom-mindmap",
        storageBucket: "stucom-mindmap.firebasestorage.app",
        messagingSenderId: "840241128239",
        appId: "1:840241128239:web:861d96fa341ac12fe0b7da"
    };

    let app = null, auth = null, db = null;

    function ensureInit() {
        if (app) return;
        try { app = firebase.app('examBlanc'); }
        catch (e) { app = firebase.initializeApp(firebaseConfig, 'examBlanc'); }
        auth = app.auth();
        db = app.firestore();
        auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    }

    function onReady(callback) {
        ensureInit();
        auth.onAuthStateChanged(callback);
    }

    function signInGoogle() {
        ensureInit();
        return auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    }

    function signOut() {
        ensureInit();
        return auth.signOut();
    }

    function getDb() {
        ensureInit();
        return db;
    }

    function scoresCollection(uid, courseId) {
        ensureInit();
        return db.collection('examBlanc').doc(uid).collection('courses').doc(courseId).collection('scores');
    }

    global.AuthGate = { onReady, signInGoogle, signOut, getDb, scoresCollection };
})(window);
