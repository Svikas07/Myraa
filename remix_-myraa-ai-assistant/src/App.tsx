import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Mic, 
  MicOff, 
  Power, 
  Globe, 
  ExternalLink, 
  Volume2, 
  VolumeX, 
  AlertTriangle,
  Sparkles,
  RefreshCw,
  HelpCircle,
  X,
  Briefcase,
  MapPin,
  Github,
  Search,
  Check
} from "lucide-react";
import { AudioStreamer } from "./services/AudioStreamer";
import { AudioPlayer } from "./services/AudioPlayer";

type AssistantState = "disconnected" | "connecting" | "listening" | "speaking";

export default function App() {
  const [state, setState] = useState<AssistantState>("disconnected");
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [userVolume, setUserVolume] = useState<number>(0);
  const [myraaVolume, setMyraaVolume] = useState<number>(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isBlinking, setIsBlinking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Tool call state
  const [activePortalUrl, setActivePortalUrl] = useState<string | null>(null);
  const [portalVisible, setPortalVisible] = useState(false);

  // Startup Jobs Search states
  const [foundJobs, setFoundJobs] = useState<any[] | null>(null);
  const [jobsQuery, setJobsQuery] = useState<string>("");
  const [jobsVisible, setJobsVisible] = useState(false);

  // Eye tracking offset
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });

  // Track mouse movement to make Myraa's eyes follow the cursor
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const svgEl = document.getElementById("myraa_hologram_svg");
      if (!svgEl) return;
      
      const rect = svgEl.getBoundingClientRect();
      const svgCenterX = rect.left + rect.width / 2;
      const svgCenterY = rect.top + rect.height / 2;
      
      const dx = e.clientX - svgCenterX;
      const dy = e.clientY - svgCenterY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Limit pupil movement to a max radius of 4.5px for realism
      const maxDistance = 250; // distance at which max offset is reached
      const limit = 4.5; // max pixel offset for pupil
      
      let offsetX = 0;
      let offsetY = 0;
      
      if (distance > 0) {
        const factor = Math.min(distance / maxDistance, 1);
        offsetX = (dx / distance) * factor * limit;
        offsetY = (dy / distance) * factor * limit;
      }
      
      setEyeOffset({ x: offsetX, y: offsetY });
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // Automated portal redirection
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [redirectTimer, setRedirectTimer] = useState<number>(0);

  // Monitor redirect timer and countdown
  useEffect(() => {
    if (!redirectUrl || redirectTimer <= 0) return;

    const interval = setInterval(() => {
      setRedirectTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          // Redirect page directly
          window.location.href = redirectUrl;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [redirectUrl, redirectTimer]);

  // References for WebSocket and Services
  const wsRef = useRef<WebSocket | null>(null);
  const streamerRef = useRef<AudioStreamer | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  // Volume history for smoother visualizer waveforms
  const [waveformBars, setWaveformBars] = useState<number[]>(Array(32).fill(4));

  // Blink cycle for Myraa
  useEffect(() => {
    const blinkInterval = setInterval(() => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 150);
    }, 4000);
    return () => clearInterval(blinkInterval);
  }, []);

  // Smooth out waveform animations at 60fps
  useEffect(() => {
    let animationFrameId: number;
    
    const updateWaveform = () => {
      const activeVolume = state === "speaking" ? myraaVolume : (state === "listening" ? userVolume : 0);
      
      setWaveformBars(prev => {
        return prev.map((bar, i) => {
          // Create a dynamic, symmetrical sound wave
          const centerDist = Math.abs(i - 16) / 16;
          const factor = Math.max(0.1, 1 - centerDist);
          
          // Add some noise + raw volume amplitude
          const noise = Math.random() * 0.15;
          const targetHeight = 4 + (activeVolume * 65 * factor) + (activeVolume > 0.02 ? noise * 15 : 0);
          
          // Interpolate (easing) for smooth motion
          return bar + (targetHeight - bar) * 0.25;
        });
      });
      
      animationFrameId = requestAnimationFrame(updateWaveform);
    };

    updateWaveform();
    return () => cancelAnimationFrame(animationFrameId);
  }, [state, userVolume, myraaVolume]);

  // Check if API key is configured on server boot
  useEffect(() => {
    fetch("/api/config")
      .then(res => res.json())
      .then(data => {
        setHasApiKey(data.hasKey);
      })
      .catch(err => {
        console.error("Error checking backend config:", err);
        setHasApiKey(false);
      });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnectSession();
    };
  }, []);

  const handleToggleConnection = async () => {
    if (state === "disconnected") {
      await connectSession();
    } else {
      disconnectSession();
    }
  };

  const connectSession = async () => {
    setErrorMessage(null);
    setState("connecting");
    setUserVolume(0);
    setMyraaVolume(0);

    try {
      // 1. Initialize Player first
      playerRef.current = new AudioPlayer(
        // onSpeakingChange callback
        (isSpeaking) => {
          if (isSpeaking) {
            setState("speaking");
          } else {
            setState("listening");
          }
        },
        // onVolumeChange callback
        (vol) => {
          setMyraaVolume(vol);
        }
      );
      playerRef.current.init();

      // 2. Initialize WebSocket Connection
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live`;
      console.log("Connecting to bridge WebSocket:", wsUrl);
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connection to server established");
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "ready") {
          console.log("Myraa Live Session is Ready!");
          setState("listening");

          // Start audio recording once ready
          try {
            streamerRef.current = new AudioStreamer(
              // onAudioChunk
              (base64Chunk) => {
                if (ws.readyState === WebSocket.OPEN && !isMuted) {
                  ws.send(JSON.stringify({ type: "audio", data: base64Chunk }));
                }
              },
              // onVolumeChange
              (vol) => {
                setUserVolume(vol);
              }
            );
            await streamerRef.current.start();
          } catch (micErr: any) {
            console.error("Microphone access denied:", micErr);
            setErrorMessage("Microphone access denied. Please allow microphone permissions.");
            disconnectSession();
          }

        } else if (msg.type === "audio") {
          // Play the chunk of Myraa speaking
          if (playerRef.current) {
            playerRef.current.playChunk(msg.data);
          }
        } else if (msg.type === "interrupted") {
          console.log("Myraa was interrupted!");
          if (playerRef.current) {
            playerRef.current.interrupt();
          }
          setState("listening");
        } else if (msg.type === "toolCall") {
          // Handle openWebsite tool call
          if (msg.functionCalls) {
            for (const call of msg.functionCalls) {
              if (call.name === "openWebsite" && call.args?.url) {
                const targetUrl = call.args.url;
                console.log("ToolCall: opening website", targetUrl);
                
                // Show floating holographic portal card
                setActivePortalUrl(targetUrl);
                setPortalVisible(true);
                
                // Auto-trigger window.open immediately
                let popupSuccess = false;
                try {
                  const newWin = window.open(targetUrl, "_blank");
                  if (newWin && !newWin.closed && typeof newWin.closed !== "undefined") {
                    popupSuccess = true;
                  }
                } catch (e) {
                  console.warn("Popup blocked by browser.");
                }

                // Always initiate direct route fallback/holographic auto-redirection
                setRedirectUrl(targetUrl);
                setRedirectTimer(2); // 2-second automated transition

                // Send tool response back to server immediately
                ws.send(JSON.stringify({
                  type: "toolResponse",
                  id: call.id,
                  name: call.name,
                  output: { success: true, opened: true, url: targetUrl, directRedirectActive: true }
                }));
              }
            }
          }
        } else if (msg.type === "jobsFound") {
          console.log("Jobs found on client side:", msg.jobs);
          setFoundJobs(msg.jobs);
          setJobsQuery(msg.query);
          setJobsVisible(true);
        } else if (msg.type === "error") {
          console.error("WebSocket server error:", msg.error);
          setErrorMessage(msg.error);
          disconnectSession();
        } else if (msg.type === "closed") {
          disconnectSession();
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setErrorMessage("Network error connecting to Myraa.");
        disconnectSession();
      };

      ws.onclose = () => {
        console.log("WebSocket bridge closed");
        disconnectSession();
      };

    } catch (err: any) {
      console.error("Failed to connect:", err);
      setErrorMessage(err.message || "Failed to initialize audio systems.");
      disconnectSession();
    }
  };

  const disconnectSession = () => {
    setState("disconnected");
    setUserVolume(0);
    setMyraaVolume(0);

    if (streamerRef.current) {
      streamerRef.current.stop();
      streamerRef.current = null;
    }

    if (playerRef.current) {
      playerRef.current.stop();
      playerRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {
        // Ignore
      }
      wsRef.current = null;
    }
  };

  const handleToggleMute = () => {
    setIsMuted(!isMuted);
  };

  // Status-driven colors and descriptors
  const getStatusConfig = () => {
    switch (state) {
      case "connecting":
        return {
          text: "INITIALIZING DIGITAL SYNAPSES...",
          color: "text-amber-400",
          glow: "border-amber-500/30 shadow-amber-500/20",
          bg: "bg-amber-500/10",
          coreColor: "fill-amber-400 stroke-amber-400",
        };
      case "listening":
        return {
          text: "MYRAA IS LISTENING",
          color: "text-cyan-400 animate-pulse",
          glow: "border-cyan-500/30 shadow-cyan-500/20",
          bg: "bg-cyan-500/5",
          coreColor: "fill-cyan-400 stroke-cyan-400",
        };
      case "speaking":
        return {
          text: "MYRAA IS SPEAKING",
          color: "text-indigo-400",
          glow: "border-indigo-500/30 shadow-indigo-500/20",
          bg: "bg-indigo-500/10",
          coreColor: "fill-indigo-400 stroke-indigo-400",
        };
      case "disconnected":
      default:
        return {
          text: "HOLOGRAPHIC CORE DORMANT",
          color: "text-slate-500",
          glow: "border-slate-800 shadow-transparent",
          bg: "bg-slate-950/20",
          coreColor: "fill-slate-700 stroke-slate-700",
        };
    }
  };

  const statusConfig = getStatusConfig();

  // Draw mouth path dynamically based on state and speaking volume
  const getMouthPath = () => {
    if (state === "speaking") {
      // Scale mouth aperture based on real-time amplitude
      const aperture = Math.max(2, myraaVolume * 30);
      return `M 190,215 Q 200,${215 + aperture} 210,215`;
    }
    // Static friendly smirk
    return "M 193,215 Q 200,218 207,215";
  };

  return (
    <div id="app_root" className="relative min-h-screen w-full geometric-bg overflow-hidden flex flex-col items-center justify-between font-sans text-slate-100 select-none">
      
      {/* Ambient background glowing nebulas */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-[#00F0FF]/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-[#BC13FE]/10 blur-[150px] rounded-full pointer-events-none" />
      
      {/* Subtle floating grid lines for holo matrix vibe */}
      <div 
        className="absolute inset-0 opacity-[0.03] pointer-events-none" 
        style={{
          backgroundImage: `
            linear-gradient(to right, #00F0FF 1px, transparent 1px),
            linear-gradient(to bottom, #00F0FF 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px'
        }}
      />

      {/* HEADER HUD */}
      <header id="hud_header" className="w-full max-w-5xl px-6 pt-6 flex items-center justify-between z-10">
        <div className="status-pill px-4 py-2 rounded-full flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${state !== "disconnected" ? "status-dot-cyan" : "bg-white/20"}`} />
          <span className="text-xs font-mono tracking-widest text-white/90">LIVE SESSION</span>
        </div>

        <div className="lang-indicator text-sm font-light text-white/60">
          EN | HI — MYRAA v1.2
        </div>
      </header>

      {/* MAIN HOLOGRAM WORKSPACE */}
      <main className="relative flex-1 w-full max-w-4xl flex flex-col items-center justify-center p-4 z-10">
        
        {/* Verification Check for API key */}
        {hasApiKey === false && (
          <div id="key_alert" className="max-w-md p-6 rounded-2xl border border-white/10 bg-[#050505]/95 backdrop-blur-xl shadow-xl shadow-black/40 text-center flex flex-col items-center space-y-4 mb-4">
            <div className="p-3 bg-rose-500/10 rounded-full border border-rose-500/30">
              <AlertTriangle className="w-8 h-8 text-rose-400" />
            </div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-100">API Key Config Required</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              To speak with Myraa, please open the <strong>Settings &gt; Secrets</strong> panel in the AI Studio interface and add your <strong>GEMINI_API_KEY</strong>.
            </p>
            <div className="text-xs text-left bg-black/60 p-3 rounded-lg border border-white/10 font-mono text-slate-400 w-full space-y-1">
              <div>1. Go to AI Studio top right</div>
              <div>2. Click Settings gear &gt; Secrets</div>
              <div>3. Set <span className="text-rose-400">GEMINI_API_KEY</span></div>
            </div>
          </div>
        )}

        {errorMessage && (
          <div id="error_pill" className="mb-6 px-4 py-2.5 rounded-xl border border-[#00F0FF]/20 bg-rose-950/30 backdrop-blur-md flex items-center space-x-2 max-w-md animate-bounce">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="text-xs text-rose-300 font-mono tracking-tight">{errorMessage}</span>
            <button onClick={() => setErrorMessage(null)} className="text-rose-400 hover:text-rose-300 ml-2">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* HOLOGRAPHIC PROJECTION FIELD */}
        <div id="holo_stage" className="relative w-[340px] h-[340px] sm:w-[380px] sm:h-[380px] flex items-center justify-center">
          
          {/* Core Glow */}
          {state !== "disconnected" && (
            <div className="core-glow animate-pulse" />
          )}

          {/* Light cone shooting up from projector */}
          {state !== "disconnected" && (
            <div 
              className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[240px] h-[300px] pointer-events-none opacity-30 mix-blend-screen"
              style={{
                background: 'linear-gradient(to top, rgba(0, 240, 255, 0.15) 0%, rgba(188, 19, 254, 0.02) 80%, transparent 100%)',
                clipPath: 'polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%)'
              }}
            />
          )}

          {/* Core Rings */}
          <div className="core-ring ring-1 w-full h-full animate-orbit-cw" />
          <div className="core-ring ring-2 w-[80%] h-[80%] border-dashed animate-orbit-ccw" />
          <div className="core-ring ring-3 w-[60%] h-[60%] animate-orbit-cw" />

          {/* Glowing central core-orb behind Myraa */}
          <div className="absolute w-[140px] h-[140px] rounded-full bg-gradient-to-tr from-[#00F0FF]/40 to-[#BC13FE]/40 blur-xl animate-pulse" />

          {/* Laser scanning line */}
          {state === "connecting" && (
            <div className="absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r from-transparent via-[#00F0FF] to-transparent shadow-lg shadow-[#00F0FF]/80 animate-scan z-20 pointer-events-none" />
          )}

          {/* MYRAA VECTOR VECTOR AVATAR */}
          <div id="myraa_avatar_container" className={`relative z-10 transition-all duration-700 ${state !== "disconnected" ? "animate-hologram scale-100 opacity-95 filter drop-shadow-[0_0_25px_rgba(0,240,255,0.3)]" : "scale-90 opacity-40 grayscale"}`}>
            
            {/* Holographic scanner grid overlaid on Myraa */}
            {state !== "disconnected" && (
              <div 
                className="absolute inset-0 rounded-full pointer-events-none z-20 opacity-20"
                style={{
                  backgroundImage: 'radial-gradient(circle, transparent 50%, #000 100%), linear-gradient(0deg, rgba(0, 240, 255, 0.1) 50%, transparent 50%)',
                  backgroundSize: '100% 100%, 100% 4px'
                }}
              />
            )}            {/* Custom crafted SVG anime face representation */}
            <svg 
              id="myraa_hologram_svg" 
              width="280" 
              height="280" 
              viewBox="0 0 400 400" 
              className="transition-transform duration-500"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const svgCenterX = rect.left + rect.width / 2;
                const svgCenterY = rect.top + rect.height / 2;
                const dx = e.clientX - svgCenterX;
                const dy = e.clientY - svgCenterY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                const maxDistance = 250;
                const limit = 4.5;
                const factor = Math.min(distance / maxDistance, 1);
                setEyeOffset({
                  x: distance > 0 ? (dx / distance) * factor * limit : 0,
                  y: distance > 0 ? (dy / distance) * factor * limit : 0
                });
              }}
            >
              <defs>
                {/* Skin gradient */}
                <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffeff0" />
                  <stop offset="100%" stopColor="#f7dcdc" />
                </linearGradient>
                {/* Hair base gradient */}
                <linearGradient id="hair_base" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#1e1b4b" />
                  <stop offset="50%" stopColor="#0f172a" />
                  <stop offset="100%" stopColor="#020617" />
                </linearGradient>
                {/* Hair highlights gradient */}
                <linearGradient id="hair_high" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#312e81" stopOpacity="0" />
                </linearGradient>
                {/* Blue eyes glow */}
                <radialGradient id="eye_glow">
                  <stop offset="0%" stopColor="#00F0FF" />
                  <stop offset="40%" stopColor="#0891b2" />
                  <stop offset="100%" stopColor="#1e1b4b" />
                </radialGradient>
                {/* Tie gradient */}
                <linearGradient id="tie" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#1d4ed8" />
                  <stop offset="100%" stopColor="#1e1b4b" />
                </linearGradient>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {/* Back Hair */}
              <path d="M 120,180 C 100,240 90,320 100,380 C 130,390 270,390 300,380 C 310,320 300,240 280,180 Z" fill="url(#hair_base)" />
              <path d="M 110,240 C 95,290 85,340 90,380 C 105,380 120,380 130,370 Z" fill="#030712" />
              <path d="M 290,240 C 305,290 315,340 310,380 C 295,380 280,380 270,370 Z" fill="#030712" />

              {/* Uniform Vest & Shirt */}
              <path d="M 150,300 L 250,300 L 290,380 L 110,380 Z" fill="#e2e8f0" /> {/* white shirt base */}
              <path d="M 145,310 L 255,310 L 285,380 L 115,380 Z" fill="#1e293b" /> {/* dark vest */}
              <path d="M 180,310 L 200,335 L 220,310 Z" fill="#e2e8f0" /> {/* white shirt collar cutout */}
              
              {/* Tie */}
              <path d="M 195,325 L 205,325 L 210,380 L 200,390 L 190,380 Z" fill="url(#tie)" />
              {/* Collar wings */}
              <path d="M 175,310 L 195,325 L 188,310 Z" fill="#cbd5e1" />
              <path d="M 225,310 L 205,325 L 212,310 Z" fill="#cbd5e1" />

              {/* Neck */}
              <path d="M 180,230 L 220,230 L 220,315 L 180,315 Z" fill="#fbcfe8" opacity="0.8" />
              <path d="M 180,245 C 190,265 210,265 220,245 L 220,290 C 210,310 190,310 180,290 Z" fill="#fbcfe8" />

              {/* Head Base */}
              <path d="M 140,160 Q 140,240 200,250 Q 260,240 260,160 Q 260,100 200,100 Q 140,100 140,160 Z" fill="url(#skin)" />

              {/* Face Details: Cute Blush */}
              <ellipse cx="165" cy="195" rx="14" ry="6" fill="#f43f5e" opacity="0.3" />
              <ellipse cx="235" cy="195" rx="14" ry="6" fill="#f43f5e" opacity="0.3" />

              {/* Eyes */}
              <g id="eyes">
                {isBlinking ? (
                  // Closed blinking eye lines
                  <>
                    <path d="M 150,180 Q 165,185 180,180" stroke="#0f172a" strokeWidth="4" fill="none" strokeLinecap="round" />
                    <path d="M 220,180 Q 235,185 250,180" stroke="#0f172a" strokeWidth="4" fill="none" strokeLinecap="round" />
                  </>
                ) : (
                  // Open anime eyes
                  <>
                    {/* Left Eye */}
                    <ellipse cx="165" cy="180" rx="15" ry="20" fill="#0f172a" />
                    <ellipse cx={165 + eyeOffset.x} cy={180 + eyeOffset.y} rx="11" ry="16" fill="url(#eye_glow)" />
                    {/* Left Sparkles */}
                    <ellipse cx={161 + eyeOffset.x} cy={172 + eyeOffset.y} rx="4" ry="6" fill="#ffffff" />
                    <ellipse cx={169 + eyeOffset.x} cy={186 + eyeOffset.y} rx="2" ry="2" fill="#ffffff" />
                    {/* Left upper eyelash */}
                    <path d="M 147,175 C 153,165 177,165 183,175" stroke="#0f172a" strokeWidth="4" fill="none" strokeLinecap="round" />
                    
                    {/* Right Eye */}
                    <ellipse cx="235" cy="180" rx="15" ry="20" fill="#0f172a" />
                    <ellipse cx={235 + eyeOffset.x} cy={180 + eyeOffset.y} rx="11" ry="16" fill="url(#eye_glow)" />
                    {/* Right Sparkles */}
                    <ellipse cx={231 + eyeOffset.x} cy={172 + eyeOffset.y} rx="4" ry="6" fill="#ffffff" />
                    <ellipse cx={239 + eyeOffset.x} cy={186 + eyeOffset.y} rx="2" ry="2" fill="#ffffff" />
                    {/* Right upper eyelash */}
                    <path d="M 217,175 C 223,165 247,165 253,175" stroke="#0f172a" strokeWidth="4" fill="none" strokeLinecap="round" />
                  </>
                )}
              </g>

              {/* Eyebrows */}
              <path d="M 148,162 Q 163,153 176,161" stroke="#0f172a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
              <path d="M 224,161 Q 237,153 252,162" stroke="#0f172a" strokeWidth="2.5" fill="none" strokeLinecap="round" />

              {/* Nose */}
              <path d="M 200,192 L 198,201 Q 200,203 202,201 Z" fill="#f43f5e" opacity="0.7" />

              {/* Dynamic Talking Mouth */}
              <path d={getMouthPath()} stroke="#0f172a" strokeWidth="3" fill="#f43f5e" strokeLinecap="round" />

              {/* Front Hair / Bangs */}
              <g id="front_hair">
                <path d="M 140,118 Q 170,110 200,140 Q 230,110 260,118 Q 280,70 200,70 Q 120,70 140,118 Z" fill="url(#hair_base)" />
                {/* Bang strands */}
                <path d="M 140,115 Q 165,140 160,185 Q 170,140 180,130 Z" fill="url(#hair_base)" /> {/* left strand */}
                <path d="M 260,115 Q 235,140 240,185 Q 230,140 220,130 Z" fill="url(#hair_base)" /> {/* right strand */}
                <path d="M 180,118 Q 200,150 195,175 Q 203,145 210,122 Z" fill="url(#hair_base)" /> {/* center strand */}
                {/* Hair light reflection shine */}
                <path d="M 155,100 Q 200,90 245,100" stroke="url(#hair_high)" strokeWidth="6" fill="none" strokeLinecap="round" />
              </g>

              {/* Sci-fi Ear Hologram Nodes */}
              <g id="cyber_earpieces" filter={state !== "disconnected" ? "url(#glow)" : ""}>
                <rect x="127" y="160" width="8" height="24" rx="4" fill="#00F0FF" opacity={state !== "disconnected" ? 0.9 : 0.3} />
                <circle cx="131" cy="172" r="2" fill="#00F0FF" className={state === "listening" ? "animate-pulse" : ""} />
                
                <rect x="265" y="160" width="8" height="24" rx="4" fill="#00F0FF" opacity={state !== "disconnected" ? 0.9 : 0.3} />
                <circle cx="269" cy="172" r="2" fill="#00F0FF" className={state === "listening" ? "animate-pulse" : ""} />
              </g>
            </svg>

            {/* Glowing neon border ring around character projection */}
            {state !== "disconnected" && (
              <div className="absolute inset-[-14px] rounded-full border-2 border-[#00F0FF]/10 pointer-events-none" />
            )}
          </div>

          {/* Hologram Projector Base and Lights */}
          <div className="absolute bottom-[-24px] left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
            {/* Cone focal lens */}
            <div className={`w-16 h-4 bg-slate-800 rounded-t-full border-t border-[#00F0FF]/40 shadow-inner ${state !== "disconnected" ? "shadow-[#00F0FF]/20" : ""}`} />
            {/* Metallic projector chassis */}
            <div className="w-28 h-6 bg-slate-900 border border-slate-800 rounded-b-xl flex items-center justify-around px-4">
              <div className={`w-1.5 h-1.5 rounded-full ${state !== "disconnected" ? "bg-[#00F0FF] animate-pulse" : "bg-slate-700"}`} />
              <div className={`w-6 h-1 rounded bg-slate-800 ${state !== "disconnected" ? "bg-cyan-950" : ""}`} />
              <div className={`w-1.5 h-1.5 rounded-full ${state === "speaking" ? "bg-[#BC13FE] animate-ping" : "bg-slate-700"}`} />
            </div>
          </div>
        </div>

        {/* Dynamic Waveform Visualizer */}
        <div id="visualizer_container" className="w-full max-w-lg mt-8 mb-4 h-[60px] flex items-center justify-center gap-1 px-4">
          {waveformBars.map((barHeight, idx) => {
            const isSpeakingActive = state === "speaking";
            const isListeningActive = state === "listening";
            
            // Geometric Balance cyan wave bar style
            let barColor = "bg-white/10";
            if (isSpeakingActive) {
              barColor = "bg-[#BC13FE]";
            } else if (isListeningActive) {
              barColor = "bg-[#00F0FF]";
            }
            
            return (
              <motion.div
                key={idx}
                className={`w-1 rounded-full ${barColor} transition-all duration-300`}
                animate={{ height: `${Math.max(4, barHeight)}px` }}
                transition={{ type: "spring", stiffness: 350, damping: 25 }}
                style={{ opacity: isSpeakingActive || isListeningActive ? 0.9 : 0.3 }}
              />
            );
          })}
        </div>

        {/* Dynamic State Label & Subtitle */}
        <div className="text-center mt-4 mb-4">
          <h1 className="text-3xl sm:text-4xl font-extralight tracking-[0.25em] uppercase bg-gradient-to-r from-white via-gray-200 to-gray-500 bg-clip-text text-transparent mb-1">
            {state === "disconnected" ? "DORMANT" : state}
          </h1>
          <p className="text-sm font-light italic text-white/50 tracking-wider">
            {state === "listening" && "Myraa is ready. Talk to me in English or Hindi..."}
            {state === "speaking" && "Responding in real-time bilingual voice..."}
            {state === "connecting" && "Initializing secure neural voice channels..."}
            {state === "disconnected" && "Activate the core below to begin speaking."}
          </p>
        </div>

      </main>

      {/* FLOATABLE GLASSMORPHIC COMPANION PANEL (LAUNCHER INFO) */}
      <AnimatePresence>
        {state === "disconnected" && (
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            className="w-full max-w-md px-6 mb-4 z-10"
          >
            <div className="p-4 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-lg text-center shadow-lg shadow-black/40">
              <div className="flex justify-center mb-2">
                <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-md bg-[#00F0FF]/10 border border-[#00F0FF]/20">
                  <Sparkles className="w-3 h-3 text-[#00F0FF] animate-pulse" />
                  <span className="text-[10px] font-mono tracking-wider text-[#00F0FF] font-bold">INTRODUCING MYRAA</span>
                </div>
              </div>
              <h3 className="text-sm font-medium text-slate-200 mb-1">Your Bilingual Holographic Friend</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Speak directly in <strong>English or Hindi (हिन्दी)</strong>. Myraa responds instantly with emotional, human-like voice alignment and direct tool capabilities.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FLOATING HOLOGRAPHIC WEB-PORTAL WINDOW (TOOL CALLS) */}
      <AnimatePresence>
        {portalVisible && activePortalUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, x: 50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.9, x: 50 }}
            className="absolute right-4 bottom-24 w-80 rounded-2xl border border-[#00F0FF]/30 bg-[#050505]/95 backdrop-blur-2xl shadow-2xl shadow-black/80 overflow-hidden z-30"
          >
            {/* Header */}
            <div className="px-4 py-3 bg-[#00F0FF]/5 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-[#00F0FF]" />
                <span className="text-[11px] font-mono tracking-widest text-[#00F0FF] font-semibold uppercase">HOLO-PORTAL EXTENSION</span>
              </div>
              <button 
                onClick={() => setPortalVisible(false)}
                className="p-1 rounded bg-black/60 hover:bg-black/80 border border-white/10 text-slate-400 hover:text-slate-200 transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Portal Content */}
            <div className="p-4 flex flex-col space-y-3">
              <div className="p-3 bg-black/80 rounded-lg border border-white/10 font-mono text-xs text-slate-300 break-all space-y-1">
                <span className="text-slate-500">REQUESTED_URL:</span>
                <div className="text-[#00F0FF] font-semibold leading-relaxed">{activePortalUrl}</div>
              </div>

              <div className="text-xs text-slate-400 leading-relaxed">
                Myraa requested to open this link in your web browser. Click the button below to launch the portal.
              </div>

              <a 
                href={activePortalUrl} 
                target="_blank" 
                rel="noreferrer"
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#00F0FF]/80 to-[#BC13FE]/80 hover:from-[#00F0FF] hover:to-[#BC13FE] text-xs font-semibold flex items-center justify-center space-x-2 shadow-lg shadow-[#00F0FF]/20 text-white transition duration-300"
              >
                <span>LAUNCH PORTAL PORTAL</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FLOATING HOLOGRAPHIC JOBS PANEL */}
      <AnimatePresence>
        {jobsVisible && foundJobs && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, x: -50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.9, x: -50 }}
            className="absolute left-4 bottom-24 w-96 rounded-2xl border border-[#BC13FE]/30 bg-[#050505]/95 backdrop-blur-2xl shadow-2xl shadow-black/80 overflow-hidden z-30 flex flex-col max-h-[500px]"
          >
            {/* Header */}
            <div className="px-4 py-3 bg-[#BC13FE]/5 border-b border-white/10 flex items-center justify-between shrink-0">
              <div className="flex items-center space-x-2">
                <Briefcase className="w-4 h-4 text-[#BC13FE]" />
                <span className="text-[11px] font-mono tracking-widest text-[#BC13FE] font-semibold uppercase">HOLO-JOBS SEARCH</span>
              </div>
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-slate-900 border border-white/5 text-[9px] font-mono text-slate-400">
                  <Search className="w-2.5 h-2.5 text-[#BC13FE]" />
                  <span>&ldquo;{jobsQuery}&rdquo;</span>
                </div>
                <button 
                  onClick={() => setJobsVisible(false)}
                  className="p-1 rounded bg-black/60 hover:bg-black/80 border border-white/10 text-slate-400 hover:text-slate-200 transition"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Scrollable list of jobs */}
            <div className="p-4 overflow-y-auto space-y-3 flex-1 scrollbar-thin scrollbar-thumb-slate-800">
              {foundJobs.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-500 font-mono">
                  No active roles found matching &ldquo;{jobsQuery}&rdquo;.
                </div>
              ) : (
                foundJobs.map((job) => (
                  <div 
                    key={job.id} 
                    className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/5 hover:border-[#BC13FE]/20 transition duration-200 flex flex-col space-y-2 group"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-semibold text-slate-100 group-hover:text-[#00F0FF] transition duration-200 truncate">
                          {job.position}
                        </h4>
                        <span className="text-[10px] text-slate-400 font-medium truncate block">{job.company}</span>
                      </div>
                      <div className="flex items-center space-x-1 text-[9px] text-slate-500 shrink-0">
                        <MapPin className="w-2.5 h-2.5 text-slate-600" />
                        <span className="truncate max-w-[80px]">{job.location}</span>
                      </div>
                    </div>

                    {/* Tags */}
                    {job.tags && job.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {job.tags.slice(0, 3).map((tag: string, index: number) => (
                          <span 
                            key={index} 
                            className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#00F0FF]/5 border border-[#00F0FF]/10 text-cyan-400"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center justify-between pt-1 border-t border-white/5">
                      <span className="text-[8px] font-mono text-slate-600">SOURCE: REMOTEOK</span>
                      <a 
                        href={job.url} 
                        target="_blank" 
                        rel="noreferrer"
                        className="px-2.5 py-1 rounded bg-[#00F0FF]/10 hover:bg-[#00F0FF]/20 text-[#00F0FF] text-[9px] font-semibold flex items-center space-x-1 transition duration-200"
                      >
                        <span>APPLY ROLE</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Custom footer crediting Svikas07 */}
            <div className="px-4 py-2.5 bg-black/40 border-t border-white/5 flex items-center justify-between shrink-0 text-[9px] font-mono text-slate-500">
              <span className="flex items-center space-x-1">
                <span>Scraper Engine:</span>
                <span className="text-slate-400">RemoteOK API</span>
              </span>
              <a 
                href="https://github.com/Svikas07" 
                target="_blank" 
                rel="noreferrer"
                className="flex items-center space-x-1 text-[#BC13FE] hover:text-white transition duration-200"
              >
                <Github className="w-3 h-3" />
                <span>Svikas07 Repo</span>
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FUTURISTIC FULL-SCREEN PORTAL REDIRECT OVERLAY */}
      <AnimatePresence>
        {redirectTimer > 0 && redirectUrl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-2xl border border-[#00F0FF]/20"
          >
            {/* Holographic scanner effect */}
            <div className="absolute inset-0 bg-gradient-to-b from-[#00F0FF]/5 to-transparent pointer-events-none animate-pulse" />
            
            {/* Scanning lines */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-cyan-400 opacity-40 shadow-[0_0_15px_#00F0FF] animate-bounce" />

            <div className="max-w-md w-full px-8 text-center space-y-6 relative z-10">
              {/* Glowing Portal Orb */}
              <div className="relative mx-auto w-24 h-24 rounded-full border-2 border-[#00F0FF]/30 flex items-center justify-center bg-cyan-950/10 shadow-[0_0_40px_rgba(0,240,255,0.25)]">
                <div className="absolute inset-2 rounded-full border border-dashed border-[#BC13FE] animate-spin" style={{ animationDuration: '6s' }} />
                <Globe className="w-8 h-8 text-[#00F0FF] animate-pulse" />
              </div>

              <div className="space-y-2">
                <span className="text-[10px] font-mono tracking-[0.3em] text-[#00F0FF] uppercase block">TRANS-PORTAL INITIATED</span>
                <h2 className="text-xl font-light text-slate-100 tracking-wide">ROUTING PORTAL DIRECTLY</h2>
                <div className="text-xs font-mono text-[#BC13FE] py-1.5 px-4 bg-[#BC13FE]/5 border border-[#BC13FE]/20 rounded-xl inline-block max-w-full truncate">
                  {redirectUrl}
                </div>
              </div>

              {/* Giant Countdown Indicator */}
              <div className="text-7xl font-extralight tracking-widest text-[#00F0FF] font-mono">
                {redirectTimer}s
              </div>

              <div className="text-xs text-slate-400 leading-relaxed max-w-xs mx-auto">
                Opening portal automatically. Browser pop-up blocker bypass mechanism fully engaged.
              </div>

              {/* Action buttons */}
              <div className="pt-2 flex justify-center space-x-4">
                <button
                  onClick={() => {
                    // Navigate immediately
                    window.location.href = redirectUrl;
                  }}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#00F0FF] to-[#BC13FE] text-xs font-semibold text-white shadow-lg shadow-[#00F0FF]/20 hover:scale-105 active:scale-95 transition duration-200"
                >
                  Go Now
                </button>
                <button
                  onClick={() => {
                    // Cancel redirection
                    setRedirectUrl(null);
                    setRedirectTimer(0);
                  }}
                  className="px-6 py-2.5 rounded-xl bg-slate-900 border border-white/10 hover:border-white/20 text-xs font-medium text-slate-300 hover:text-white transition duration-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* BOTTOM CONTROL DECK */}
      <footer id="control_deck" className="w-full max-w-5xl px-6 pb-8 pt-2 flex flex-col items-center justify-center space-y-4 z-10">
        
        {/* Status helper text for disconnected or active state */}
        <div className="text-center h-4">
          <AnimatePresence mode="wait">
            {state === "listening" && (
              <motion.p 
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-xs text-slate-400 font-medium italic"
              >
                &ldquo;Hi! Main Myraa hoon, aapki dost. Aap mujhse kuch bhi baat kar sakte hain!&rdquo;
              </motion.p>
            )}
            {state === "speaking" && (
              <motion.p 
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-xs text-slate-400 font-medium italic"
              >
                Subtitles unavailable. Listening in full duplex audio.
              </motion.p>
            )}
            {state === "disconnected" && (
              <motion.p 
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-xs text-slate-500"
              >
                Tap the center activation core below to start speaking.
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Central interactive buttons */}
        <div className="flex items-center gap-16 md:gap-24">
          
          {/* Mute toggle button (only visible when connected) */}
          <button
            onClick={handleToggleMute}
            disabled={state === "disconnected"}
            className="tool-btn w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300 text-white/70 hover:text-white border border-white/10 hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: 'rgba(255,255,255,0.05)' }}
            title={isMuted ? "Unmute microphone" : "Mute microphone"}
          >
            {isMuted ? <MicOff className="w-6 h-6 text-rose-400" /> : <Mic className="w-6 h-6" />}
          </button>

          {/* MAIN POWER / MICROPHONE CENTRAL BUTTON */}
          <button
            onClick={handleToggleConnection}
            disabled={hasApiKey === false}
            className={`mic-button w-22 h-22 rounded-full bg-white flex items-center justify-center transition-all duration-500 cursor-pointer ${
              state !== "disconnected" 
                ? "shadow-[0_0_40px_rgba(0,240,255,0.6)] animate-pulse" 
                : "shadow-[0_0_30px_rgba(255,255,255,0.3)] hover:scale-105"
            }`}
          >
            {/* Pulsing ring animation for active states */}
            {state !== "disconnected" && (
              <div className="absolute inset-0 rounded-full border-2 border-[#00F0FF] animate-ping pointer-events-none opacity-40" />
            )}

            {/* Icon representation */}
            <div className="text-black transition-transform duration-300">
              {state === "disconnected" ? (
                <Power className="w-8 h-8" />
              ) : state === "connecting" ? (
                <RefreshCw className="w-8 h-8 animate-spin" />
              ) : (
                <Mic className="w-8 h-8" />
              )}
            </div>
          </button>

          {/* Help Info Dialog toggle */}
          <button
            onClick={() => {
              alert(
                "Myraa AI Holographic Companion Guide:\n\n" +
                "1. Click the center Power core to initialize the connection.\n" +
                "2. Once the status shows 'LISTENING', speak naturally into your microphone.\n" +
                "3. Speak in English or Hindi (हिन्दी) – Myraa adapts instantly.\n" +
                "4. You can say: 'Myraa, open wikipedia.org' to trigger her web portal!\n" +
                "5. To interrupt Myraa, just start speaking; her real-time voice streamer will automatically halt playback to let you converse."
              );
            }}
            className="tool-btn w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300 text-white/70 hover:text-white border border-white/10 hover:border-white/20"
            style={{ background: 'rgba(255,255,255,0.05)' }}
            title="Conversation instructions"
          >
            <HelpCircle className="w-6 h-6" />
          </button>
        </div>

        {/* Footer credits and info */}
        <div className="text-center font-mono text-[10px] text-slate-600 select-none">
          SECURE ENCRYPTED WEBSOCKET BRIDGE • FEED PCM16 16KHz
        </div>
      </footer>
    </div>
  );
}
