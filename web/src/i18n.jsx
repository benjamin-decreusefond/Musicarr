import { createContext, useContext, useState, useCallback } from 'react';

// Lightweight, dependency-free i18n. Strings live in the dictionary below keyed
// by a stable id; t('key') falls back to English and then the key itself, so a
// missing translation degrades gracefully rather than blowing up. Simple
// {var} interpolation is supported: t('x.y', { n: 3 }).

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
];

const STRINGS = {
  en: {
    'nav.home': 'Home', 'nav.search': 'Search', 'nav.explore': 'Explore',
    'nav.madeForYou': 'Made for you', 'nav.library': 'Library', 'nav.liked': 'Liked songs',
    'nav.following': 'Following', 'nav.offline': 'Offline', 'nav.downloads': 'Downloads',
    'nav.stats': 'Your stats', 'nav.equalizer': 'Equalizer', 'nav.profile': 'Profile',
    'nav.users': 'Users', 'nav.settings': 'Settings', 'nav.playlists': 'Playlists',
    'nav.newPlaylist': 'New playlist',

    'common.play': 'Play', 'common.pause': 'Pause', 'common.shuffle': 'Shuffle',
    'common.playAll': 'Play all', 'common.download': 'Download', 'common.loading': 'Loading…',
    'common.nothingHere': 'Nothing here yet.', 'common.cancel': 'Cancel', 'common.save': 'Save',

    'ctx.play': 'Play', 'ctx.playNext': 'Play next', 'ctx.addToQueue': 'Add to queue',
    'ctx.addToPlaylist': 'Add to playlist', 'ctx.newPlaylist': 'New playlist…',
    'ctx.like': 'Add to liked songs', 'ctx.unlike': 'Remove from liked songs',
    'ctx.goToArtist': 'Go to artist', 'ctx.goToAlbum': 'Go to album',
    'ctx.download': 'Download', 'ctx.saveOffline': 'Save for offline',
    'ctx.removeOffline': 'Remove offline copy', 'ctx.startRadio': 'Start radio',
    'ctx.deleteFromLibrary': 'Delete from library', 'ctx.openAlbum': 'Open album',
    'ctx.downloadAlbum': 'Download album', 'ctx.openArtist': 'Open artist',
    'ctx.noPlaylists': 'No playlists yet',

    'player.nothingPlaying': 'Nothing playing', 'player.queue': 'Queue',
    'player.lyrics': 'Lyrics', 'player.friendActivity': 'Friend activity',
    'player.listenTogether': 'Listen together', 'player.next': 'Next', 'player.previous': 'Previous',

    'auth.tagline': 'Your music, your server.', 'auth.username': 'Username',
    'auth.password': 'Password', 'auth.signIn': 'Sign in', 'auth.signingIn': 'Signing in…',
    'auth.signOut': 'Sign out',

    'greet.morning': 'Good morning', 'greet.afternoon': 'Good afternoon',
    'greet.evening': 'Good evening', 'greet.night': 'Late night',

    'settings.language': 'Language',
    'settings.languageHint': 'Choose the language for the Musicarr interface.',
    'toast.queued': 'Added to queue', 'toast.playNext': 'Playing next',
  },
  fr: {
    'nav.home': 'Accueil', 'nav.search': 'Rechercher', 'nav.explore': 'Explorer',
    'nav.madeForYou': 'Pour vous', 'nav.library': 'Bibliothèque', 'nav.liked': 'Titres likés',
    'nav.following': 'Abonnements', 'nav.offline': 'Hors ligne', 'nav.downloads': 'Téléchargements',
    'nav.stats': 'Vos stats', 'nav.equalizer': 'Égaliseur', 'nav.profile': 'Profil',
    'nav.users': 'Utilisateurs', 'nav.settings': 'Paramètres', 'nav.playlists': 'Playlists',
    'nav.newPlaylist': 'Nouvelle playlist',

    'common.play': 'Lire', 'common.pause': 'Pause', 'common.shuffle': 'Aléatoire',
    'common.playAll': 'Tout lire', 'common.download': 'Télécharger', 'common.loading': 'Chargement…',
    'common.nothingHere': 'Rien pour le moment.', 'common.cancel': 'Annuler', 'common.save': 'Enregistrer',

    'ctx.play': 'Lire', 'ctx.playNext': 'Lire ensuite', 'ctx.addToQueue': "Ajouter à la file d'attente",
    'ctx.addToPlaylist': 'Ajouter à une playlist', 'ctx.newPlaylist': 'Nouvelle playlist…',
    'ctx.like': 'Ajouter aux titres likés', 'ctx.unlike': 'Retirer des titres likés',
    'ctx.goToArtist': "Aller à l'artiste", 'ctx.goToAlbum': "Aller à l'album",
    'ctx.download': 'Télécharger', 'ctx.saveOffline': 'Enregistrer hors ligne',
    'ctx.removeOffline': 'Supprimer la copie hors ligne', 'ctx.startRadio': 'Lancer la radio',
    'ctx.deleteFromLibrary': 'Supprimer de la bibliothèque', 'ctx.openAlbum': "Ouvrir l'album",
    'ctx.downloadAlbum': "Télécharger l'album", 'ctx.openArtist': "Ouvrir l'artiste",
    'ctx.noPlaylists': 'Aucune playlist',

    'player.nothingPlaying': 'Aucune lecture', 'player.queue': "File d'attente",
    'player.lyrics': 'Paroles', 'player.friendActivity': 'Activité des amis',
    'player.listenTogether': 'Écouter ensemble', 'player.next': 'Suivant', 'player.previous': 'Précédent',

    'auth.tagline': 'Votre musique, votre serveur.', 'auth.username': "Nom d'utilisateur",
    'auth.password': 'Mot de passe', 'auth.signIn': 'Se connecter', 'auth.signingIn': 'Connexion…',
    'auth.signOut': 'Se déconnecter',

    'greet.morning': 'Bonjour', 'greet.afternoon': 'Bon après-midi',
    'greet.evening': 'Bonsoir', 'greet.night': 'Bonne nuit',

    'settings.language': 'Langue',
    'settings.languageHint': "Choisissez la langue de l'interface Musicarr.",
    'toast.queued': "Ajouté à la file d'attente", 'toast.playNext': 'Lecture suivante',
  },
  es: {
    'nav.home': 'Inicio', 'nav.search': 'Buscar', 'nav.explore': 'Explorar',
    'nav.madeForYou': 'Para ti', 'nav.library': 'Biblioteca', 'nav.liked': 'Me gusta',
    'nav.following': 'Siguiendo', 'nav.offline': 'Sin conexión', 'nav.downloads': 'Descargas',
    'nav.stats': 'Tus estadísticas', 'nav.equalizer': 'Ecualizador', 'nav.profile': 'Perfil',
    'nav.users': 'Usuarios', 'nav.settings': 'Ajustes', 'nav.playlists': 'Listas',
    'nav.newPlaylist': 'Nueva lista',

    'common.play': 'Reproducir', 'common.pause': 'Pausa', 'common.shuffle': 'Aleatorio',
    'common.playAll': 'Reproducir todo', 'common.download': 'Descargar', 'common.loading': 'Cargando…',
    'common.nothingHere': 'Nada por aquí todavía.', 'common.cancel': 'Cancelar', 'common.save': 'Guardar',

    'ctx.play': 'Reproducir', 'ctx.playNext': 'Reproducir a continuación', 'ctx.addToQueue': 'Añadir a la cola',
    'ctx.addToPlaylist': 'Añadir a una lista', 'ctx.newPlaylist': 'Nueva lista…',
    'ctx.like': 'Añadir a me gusta', 'ctx.unlike': 'Quitar de me gusta',
    'ctx.goToArtist': 'Ir al artista', 'ctx.goToAlbum': 'Ir al álbum',
    'ctx.download': 'Descargar', 'ctx.saveOffline': 'Guardar sin conexión',
    'ctx.removeOffline': 'Eliminar copia sin conexión', 'ctx.startRadio': 'Iniciar radio',
    'ctx.deleteFromLibrary': 'Eliminar de la biblioteca', 'ctx.openAlbum': 'Abrir álbum',
    'ctx.downloadAlbum': 'Descargar álbum', 'ctx.openArtist': 'Abrir artista',
    'ctx.noPlaylists': 'Aún no hay listas',

    'player.nothingPlaying': 'Nada en reproducción', 'player.queue': 'Cola',
    'player.lyrics': 'Letras', 'player.friendActivity': 'Actividad de amigos',
    'player.listenTogether': 'Escuchar juntos', 'player.next': 'Siguiente', 'player.previous': 'Anterior',

    'auth.tagline': 'Tu música, tu servidor.', 'auth.username': 'Usuario',
    'auth.password': 'Contraseña', 'auth.signIn': 'Entrar', 'auth.signingIn': 'Entrando…',
    'auth.signOut': 'Salir',

    'greet.morning': 'Buenos días', 'greet.afternoon': 'Buenas tardes',
    'greet.evening': 'Buenas noches', 'greet.night': 'Buenas noches',

    'settings.language': 'Idioma',
    'settings.languageHint': 'Elige el idioma de la interfaz de Musicarr.',
    'toast.queued': 'Añadido a la cola', 'toast.playNext': 'Se reproducirá a continuación',
  },
  de: {
    'nav.home': 'Start', 'nav.search': 'Suche', 'nav.explore': 'Entdecken',
    'nav.madeForYou': 'Für dich', 'nav.library': 'Bibliothek', 'nav.liked': 'Lieblingssongs',
    'nav.following': 'Folge ich', 'nav.offline': 'Offline', 'nav.downloads': 'Downloads',
    'nav.stats': 'Deine Statistiken', 'nav.equalizer': 'Equalizer', 'nav.profile': 'Profil',
    'nav.users': 'Benutzer', 'nav.settings': 'Einstellungen', 'nav.playlists': 'Playlists',
    'nav.newPlaylist': 'Neue Playlist',

    'common.play': 'Abspielen', 'common.pause': 'Pause', 'common.shuffle': 'Zufall',
    'common.playAll': 'Alle abspielen', 'common.download': 'Herunterladen', 'common.loading': 'Lädt…',
    'common.nothingHere': 'Noch nichts hier.', 'common.cancel': 'Abbrechen', 'common.save': 'Speichern',

    'ctx.play': 'Abspielen', 'ctx.playNext': 'Als Nächstes spielen', 'ctx.addToQueue': 'Zur Warteschlange',
    'ctx.addToPlaylist': 'Zur Playlist hinzufügen', 'ctx.newPlaylist': 'Neue Playlist…',
    'ctx.like': 'Zu Lieblingssongs', 'ctx.unlike': 'Aus Lieblingssongs entfernen',
    'ctx.goToArtist': 'Zum Künstler', 'ctx.goToAlbum': 'Zum Album',
    'ctx.download': 'Herunterladen', 'ctx.saveOffline': 'Offline speichern',
    'ctx.removeOffline': 'Offline-Kopie entfernen', 'ctx.startRadio': 'Radio starten',
    'ctx.deleteFromLibrary': 'Aus Bibliothek löschen', 'ctx.openAlbum': 'Album öffnen',
    'ctx.downloadAlbum': 'Album herunterladen', 'ctx.openArtist': 'Künstler öffnen',
    'ctx.noPlaylists': 'Noch keine Playlists',

    'player.nothingPlaying': 'Nichts wird abgespielt', 'player.queue': 'Warteschlange',
    'player.lyrics': 'Songtext', 'player.friendActivity': 'Freunde-Aktivität',
    'player.listenTogether': 'Zusammen hören', 'player.next': 'Weiter', 'player.previous': 'Zurück',

    'auth.tagline': 'Deine Musik, dein Server.', 'auth.username': 'Benutzername',
    'auth.password': 'Passwort', 'auth.signIn': 'Anmelden', 'auth.signingIn': 'Anmeldung…',
    'auth.signOut': 'Abmelden',

    'greet.morning': 'Guten Morgen', 'greet.afternoon': 'Guten Tag',
    'greet.evening': 'Guten Abend', 'greet.night': 'Gute Nacht',

    'settings.language': 'Sprache',
    'settings.languageHint': 'Wähle die Sprache der Musicarr-Oberfläche.',
    'toast.queued': 'Zur Warteschlange hinzugefügt', 'toast.playNext': 'Wird als Nächstes gespielt',
  },
};

const LANG_KEY = 'musicarr:lang';
function detectLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && STRINGS[saved]) return saved;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return STRINGS[nav] ? nav : 'en';
}

const LangCtx = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(detectLang);
  const setLang = useCallback((code) => {
    if (!STRINGS[code]) return;
    localStorage.setItem(LANG_KEY, code);
    document.documentElement.lang = code;
    setLangState(code);
  }, []);
  const t = useCallback((key, vars) => {
    let s = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
    if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
    return s;
  }, [lang]);
  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}

export function useLang() {
  const ctx = useContext(LangCtx);
  return ctx || { lang: 'en', setLang: () => {}, t: (k) => (STRINGS.en[k] ?? k) };
}
// Convenience hook returning just the translate function.
export function useT() { return useLang().t; }
