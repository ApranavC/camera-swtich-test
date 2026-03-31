// Meeting ID is static as requested
const VKYC_MEETING_ID = "jpjl-vag0-fr6v";

/**
 * TOKEN Management:
 * - Local Dev: Pulls from the .env file (VITE_VIDEOSDK_TOKEN)
 * - Production: Pulls from Vercel's Environment Variables (VITE_VIDEOSDK_TOKEN)
 */
const TOKEN = import.meta.env.VITE_VIDEOSDK_TOKEN;

// Exposing to window for global access
window.TOKEN = TOKEN;
window.VKYC_MEETING_ID = VKYC_MEETING_ID;

if (!TOKEN) {
    console.error(
        "VideoSDK Token is missing. Please add VITE_VIDEOSDK_TOKEN to your .env file or Vercel Environment Variables.",
    );
}