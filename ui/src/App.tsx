import React, { useState, useEffect } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import { 
  Play, 
  CheckCircle2, 
  FileText, 
  Settings as SettingsIcon, 
  Sun, 
  Moon,
  ChevronDown,
  ChevronUp,
  X,
  ExternalLink,
  Search,
  Filter
} from 'lucide-react';
import JobJetLogo from './assets/jobjet.svg';

const API = "http://localhost:3001";
const inputCls = "w-full px-3 py-2 border rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600 focus:ring-blue-500 focus:border-blue-500";

interface EvaluationProgress {
  isRunning: boolean;
  total: number;
  current: number;
  approvedCount: number;
  rejectedCount: number;
  currentJobTitle: string;
  currentCompany: string;
  currentScore: number | null;
  status: "idle" | "evaluating" | "completed" | "error";
  error: string | null;
}

const EvaluationProgressCard = ({ 
  progress, 
  onViewApproved 
}: { 
  progress: EvaluationProgress | null; 
  onViewApproved?: () => void;
}) => {
  if (!progress || progress.status === 'idle') return null;

  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const isCompleted = progress.status === 'completed';
  const isRunning = progress.isRunning || progress.status === 'evaluating';

  if (!isRunning && !isCompleted && !progress.error) return null;

  return (
    <div className={`p-5 rounded-lg border shadow-sm transition-all duration-300 ${
      isCompleted 
        ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
        : progress.error
        ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
        : 'bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800'
    }`}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center space-x-2">
          {isRunning && (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-600"></span>
            </span>
          )}
          {isCompleted && <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />}
          <h4 className="font-semibold text-gray-900 dark:text-white text-sm sm:text-base">
            {isRunning ? "AI Scoring Matrix In Progress..." : isCompleted ? "AI Scoring Completed!" : "Evaluation Issue Encountered"}
          </h4>
        </div>
        <span className="text-sm font-bold font-mono text-purple-700 dark:text-purple-300">{pct}%</span>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-3 overflow-hidden">
        <div 
          className={`h-2.5 rounded-full transition-all duration-500 ease-out ${
            isCompleted 
              ? 'bg-green-500' 
              : 'bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Details & Counter Pills */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs text-gray-600 dark:text-gray-300 gap-2">
        <div className="truncate max-w-md">
          {isRunning && progress.currentJobTitle ? (
            <span>Scoring: <strong className="font-medium text-gray-900 dark:text-white">"{progress.currentJobTitle}"</strong> @ {progress.currentCompany}</span>
          ) : isCompleted ? (
            <span className="text-green-700 dark:text-green-400 font-medium">Evaluation finished. {progress.approvedCount} jobs met your threshold!</span>
          ) : progress.error ? (
            <span className="text-red-600 dark:text-red-400">{progress.error}</span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <span className="px-2 py-0.5 rounded bg-white dark:bg-gray-800 border dark:border-gray-700 font-mono text-gray-700 dark:text-gray-300">
            {progress.current}/{progress.total}
          </span>
          <span className="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300 font-medium">
            ✔ {progress.approvedCount} Approved
          </span>
          <span className="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300 font-medium">
            ✖ {progress.rejectedCount} Rejected
          </span>
          {progress.currentScore !== null && isRunning && (
            <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 font-bold">
              Score: {progress.currentScore}%
            </span>
          )}
          {isCompleted && onViewApproved && (
            <button 
              onClick={onViewApproved} 
              className="ml-2 px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded font-medium text-xs transition"
            >
              Review Approved →
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface AutomationProgress {
  isRunning: boolean;
  status: "idle" | "starting" | "waiting_login" | "navigating" | "filling" | "review" | "cooldown" | "completed" | "error" | "stopped";
  total: number;
  currentIndex: number;
  currentJob: {
    title: string;
    company: string;
    url: string;
    location?: string;
    matchScore?: number;
  } | null;
  currentStepMessage: string;
  appliedCount: number;
  skippedCount: number;
  haltedCount: number;
  errorCount: number;
  logs: Array<{ timestamp: string; message: string; type: "info" | "success" | "warn" | "error" }>;
  currentAnswers: Array<{ question: string; answer: string | null; tier: string }>;
  error?: string;
}

const AutomationProgressCard = ({
  progress,
  onStop,
}: {
  progress: AutomationProgress | null;
  onStop?: () => void;
}) => {
  const [showLogs, setShowLogs] = useState(false);
  const [showAnswers, setShowAnswers] = useState(true);

  if (!progress || (!progress.isRunning && progress.status === "idle")) {
    return null;
  }

  const {
    isRunning,
    status,
    total,
    currentIndex,
    currentJob,
    currentStepMessage,
    appliedCount,
    skippedCount,
    haltedCount,
    errorCount,
    logs = [],
    currentAnswers = [],
  } = progress;

  const pct = total > 0 ? Math.round((currentIndex / total) * 100) : isRunning ? 10 : 100;
  const isCompleted = status === "completed";
  const isReview = status === "review";
  const isLogin = status === "waiting_login";
  const isError = status === "error";

  return (
    <div className={`p-5 rounded-xl shadow-md border transition-all duration-300 ${
      isLogin
        ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800'
        : isReview
          ? 'bg-purple-50 dark:bg-purple-950/30 border-purple-300 dark:border-purple-800'
          : isCompleted
            ? 'bg-green-50 dark:bg-green-950/30 border-green-300 dark:border-green-800'
            : isError
              ? 'bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-800'
              : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-3">
          {isRunning && (
            <span className="relative flex h-3.5 w-3.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                isLogin ? 'bg-amber-400' : isReview ? 'bg-purple-400' : 'bg-blue-400'
              }`} />
              <span className={`relative inline-flex rounded-full h-3.5 w-3.5 ${
                isLogin ? 'bg-amber-600' : isReview ? 'bg-purple-600' : 'bg-blue-600'
              }`} />
            </span>
          )}
          {isCompleted && <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />}
          {isError && <X className="w-5 h-5 text-red-600 dark:text-red-400" />}

          <div>
            <div className="flex items-center space-x-2">
              <h4 className="font-bold text-gray-900 dark:text-white text-base">
                {isLogin
                  ? "Action Required: Log into LinkedIn"
                  : isReview
                    ? "Human Review: Pre-filled Application Ready!"
                    : isCompleted
                      ? "Browser Automation Completed!"
                      : isError
                        ? "Automation Stopped on Error"
                        : "Live Browser Automation Active"}
              </h4>
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
                isLogin
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300'
                  : isReview
                    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300'
                    : isCompleted
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                      : 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300'
              }`}>
                {status.replace('_', ' ')}
              </span>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
              {currentStepMessage || "Processing application queue..."}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {isRunning && onStop && (
            <button
              onClick={onStop}
              className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-semibold transition shadow"
            >
              Stop Automation
            </button>
          )}
          <span className="text-sm font-bold font-mono text-gray-700 dark:text-gray-300">
            {total > 0 ? `${currentIndex}/${total}` : ""} ({pct}%)
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-4 overflow-hidden">
        <div
          className={`h-2.5 rounded-full transition-all duration-500 ease-out ${
            isCompleted
              ? 'bg-green-500'
              : isReview
                ? 'bg-gradient-to-r from-purple-500 to-pink-500'
                : isLogin
                  ? 'bg-amber-500'
                  : 'bg-gradient-to-r from-blue-500 to-indigo-600'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Prominent Action Banners */}
      {isLogin && (
        <div className="mb-4 p-3.5 bg-amber-100/90 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 rounded-lg text-sm text-amber-900 dark:text-amber-200 flex items-start space-x-3">
          <span className="text-xl shrink-0">🌐</span>
          <div className="space-y-1">
            <div className="font-bold text-amber-950 dark:text-amber-100">
              Google Chrome window opened on your screen!
            </div>
            <div className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
              Check your <strong>Windows Taskbar</strong> for the Google Chrome icon. An automated browser window has navigated to the LinkedIn sign-in page. Simply enter your LinkedIn credentials there. Once logged in, Job Jet will auto-detect your active session and proceed to apply.
            </div>
          </div>
        </div>
      )}

      {isReview && (
        <div className="mb-4 p-3.5 bg-purple-100/90 dark:bg-purple-900/40 border border-purple-300 dark:border-purple-700 rounded-lg text-sm text-purple-900 dark:text-purple-200 flex items-start space-x-3 animate-pulse">
          <span className="text-xl shrink-0">👀</span>
          <div className="space-y-1">
            <div className="font-bold text-purple-950 dark:text-purple-100">
              Application is pre-filled and waiting for your review!
            </div>
            <div className="text-xs leading-relaxed text-purple-900 dark:text-purple-200">
              Switch to the opened Google Chrome window on your taskbar, review the pre-filled fields, and click <strong>"Submit application"</strong>. Job Jet will automatically detect when submitted and move to the next job.
            </div>
          </div>
        </div>
      )}

      {/* Current Job Box */}
      {currentJob && (
        <div className="bg-white dark:bg-gray-800 p-3.5 rounded-lg border dark:border-gray-700 mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-semibold uppercase">Current Job</div>
            <div className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <span>{currentJob.title}</span>
              <span className="text-gray-500 font-normal">@ {currentJob.company}</span>
              {currentJob.matchScore && (
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                  {currentJob.matchScore}% Match
                </span>
              )}
            </div>
            {currentJob.location && <div className="text-xs text-gray-500">{currentJob.location}</div>}
          </div>
          <a
            href={currentJob.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
          >
            View Posting <ExternalLink className="w-3.5 h-3.5 ml-1" />
          </a>
        </div>
      )}

      {/* Answers Preview */}
      {currentAnswers && currentAnswers.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setShowAnswers(!showAnswers)}
            className="text-xs font-semibold text-purple-700 dark:text-purple-400 flex items-center gap-1 mb-1.5"
          >
            {showAnswers ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            AI Pre-filled Fields ({currentAnswers.length})
          </button>
          {showAnswers && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-3 border dark:border-gray-700 max-h-40 overflow-y-auto space-y-1.5 text-xs">
              {currentAnswers.map((a, idx) => (
                <div key={idx} className="flex items-start justify-between border-b dark:border-gray-700/50 pb-1 last:border-0 last:pb-0">
                  <span className="text-gray-600 dark:text-gray-300 font-medium truncate max-w-[60%]">{a.question}</span>
                  <span className="font-mono text-gray-900 dark:text-white truncate max-w-[38%] text-right font-semibold">
                    {a.answer || <span className="text-red-500">Unanswered</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Counters & Logs Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t dark:border-gray-700/60 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300 font-bold">
            ✔ {appliedCount} Applied
          </span>
          <span className="px-2 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-300 font-medium">
            ⚠ {haltedCount} Halted / Review
          </span>
          <span className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
            ↷ {skippedCount} Skipped
          </span>
          {errorCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300 font-bold">
              ✖ {errorCount} Errors
            </span>
          )}
        </div>

        <button
          onClick={() => setShowLogs(!showLogs)}
          className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white flex items-center gap-1 font-medium"
        >
          {showLogs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Live Activity Log ({logs.length})
        </button>
      </div>

      {/* Logs Drawer */}
      {showLogs && (
        <div className="mt-3 bg-gray-900 text-gray-200 p-3 rounded-lg font-mono text-[11px] max-h-48 overflow-y-auto space-y-1">
          {logs.length === 0 ? (
            <div className="text-gray-500">No logs yet...</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-gray-500">[{l.timestamp}]</span>
                <span className={
                  l.type === 'error' ? 'text-red-400' :
                  l.type === 'warn' ? 'text-amber-400' :
                  l.type === 'success' ? 'text-green-400' :
                  'text-gray-300'
                }>
                  {l.message}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const OrchestratorTab = ({ onNavigateToJobs }: { onNavigateToJobs?: () => void }) => {
  const [isIngesting, setIsIngesting] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [fileResume, setFileResume] = useState<File | null>(null);
  const [fileLinkedin, setFileLinkedin] = useState<File | null>(null);
  const [docs, setDocs] = useState<{resume?: string, linkedin?: string}>({});
  const [profile, setProfile] = useState<any>(null);
  const [rawJobCount, setRawJobCount] = useState(0);
  const [approvedJobCount, setApprovedJobCount] = useState(0);
  const [evalProgress, setEvalProgress] = useState<EvaluationProgress | null>(null);
  const [autoProgress, setAutoProgress] = useState<AutomationProgress | null>(null);
  const [isAutomating, setIsAutomating] = useState(false);

  const fetchData = async () => {
    try {
      const [docsRes, profileRes, rawJobsRes, jobsRes] = await Promise.all([
        fetch(`${API}/api/documents`),
        fetch(`${API}/api/profile`),
        fetch(`${API}/api/jobs/raw`),
        fetch(`${API}/api/jobs`)
      ]);
      if (docsRes.ok) setDocs(await docsRes.json());
      if (profileRes.ok) setProfile(await profileRes.json());
      if (rawJobsRes.ok) {
        const rj = await rawJobsRes.json();
        setRawJobCount(rj.length);
      }
      if (jobsRes.ok) {
        const j = await jobsRes.json();
        setApprovedJobCount(j.length);
      }
    } catch (e) {
      toast.error("Failed to fetch orchestrator data");
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Poll automation progress
  useEffect(() => {
    let interval: any = null;
    const checkAutoProgress = async () => {
      try {
        const res = await fetch(`${API}/api/pipeline/apply/progress`);
        if (res.ok) {
          const data: AutomationProgress = await res.json();
          setAutoProgress(data);
          if (data.isRunning) {
            setIsAutomating(true);
          } else if (isAutomating && (data.status === 'completed' || data.status === 'stopped')) {
            setIsAutomating(false);
            if (data.status === 'completed') {
              toast.success(`Browser automation complete! Applied to ${data.appliedCount} jobs.`);
            }
            fetchData();
          }
        }
      } catch (e) {}
    };

    checkAutoProgress();
    interval = setInterval(checkAutoProgress, 1000);
    return () => clearInterval(interval);
  }, [isAutomating]);

  // Poll evaluation progress
  useEffect(() => {
    let interval: any = null;
    const checkProgress = async () => {
      try {
        const res = await fetch(`${API}/api/pipeline/evaluate/progress`);
        if (res.ok) {
          const data: EvaluationProgress = await res.json();
          setEvalProgress(data);
          if (data.isRunning) {
            setIsEvaluating(true);
          } else if (isEvaluating && data.status === 'completed') {
            setIsEvaluating(false);
            toast.success(`Evaluation complete! ${data.approvedCount} jobs approved.`);
            fetchData();
          }
        }
      } catch (e) {}
    };

    checkProgress();
    interval = setInterval(checkProgress, 1200);
    return () => clearInterval(interval);
  }, [isEvaluating]);

  const handleUpload = async (type: 'resume' | 'linkedin', file: File | null) => {
    if (!file) return;
    const formData = new FormData();
    formData.append(type, file);
    try {
      const res = await fetch(`${API}/api/upload`, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) throw new Error("Upload failed");
      toast.success(`${type} uploaded successfully`);
      fetchData();
    } catch (e) {
      toast.error("Failed to upload document");
    }
  };

  const handleExtract = async () => {
    setIsExtracting(true);
    try {
      const res = await fetch(`${API}/api/pipeline/extract-profile`, { method: 'POST' });
      if (!res.ok) throw new Error("Failed");
      toast.success("Profile extracted");
      fetchData();
    } catch (e) {
      toast.error("Extraction failed");
    } finally {
      setIsExtracting(false);
    }
  };

  const handleIngest = async () => {
    setIsIngesting(true);
    try {
      const res = await fetch(`${API}/api/pipeline/ingest`, { method: 'POST' });
      if (!res.ok) throw new Error("Failed");
      toast.success("Scraping completed");
      fetchData();
    } catch (e) {
      toast.error("Scraping failed");
    } finally {
      setIsIngesting(false);
    }
  };

  const handleEvaluate = async () => {
    setIsEvaluating(true);
    try {
      const res = await fetch(`${API}/api/pipeline/evaluate`, { method: 'POST' });
      if (!res.ok) throw new Error("Failed");
      toast.success("AI Scoring started in background");
    } catch (e) {
      toast.error("Evaluation failed to start");
      setIsEvaluating(false);
    }
  };

  const handleLaunch = async () => {
    setIsAutomating(true);
    try {
      const res = await fetch(`${API}/api/pipeline/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false })
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast.success(data.message || "Browser automation started!");
      const pRes = await fetch(`${API}/api/pipeline/apply/progress`);
      if (pRes.ok) {
        setAutoProgress(await pRes.json());
      }
    } catch (e) {
      toast.error("Launch failed to start");
      setIsAutomating(false);
    }
  };

  const handleStopAutomation = async () => {
    try {
      await fetch(`${API}/api/pipeline/apply/stop`, { method: 'POST' });
      toast.success("Stopping browser automation...");
    } catch (e) {
      toast.error("Failed to stop automation");
    }
  };

  return (
    <div className="space-y-6">
      {/* Pipeline Status Bar */}
      <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow flex items-center justify-between overflow-x-auto">
        <div className="flex items-center space-x-4 min-w-max">
          <div className="flex flex-col items-center">
            {docs.resume && docs.linkedin ? <CheckCircle2 className="text-green-500 w-8 h-8" /> : <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700" />}
            <span className="text-sm mt-1">Upload Docs</span>
          </div>
          <div className="w-12 h-1 bg-gray-300 dark:bg-gray-600 mb-5"></div>
          <div className="flex flex-col items-center">
            {profile?.raw_extracted ? <CheckCircle2 className="text-green-500 w-8 h-8" /> : <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700" />}
            <span className="text-sm mt-1">Build Profile</span>
          </div>
          <div className="w-12 h-1 bg-gray-300 dark:bg-gray-600 mb-5"></div>
          <div className="flex flex-col items-center">
            {rawJobCount > 0 ? <CheckCircle2 className="text-green-500 w-8 h-8" /> : <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700" />}
            <span className="text-sm mt-1">Scrape Jobs</span>
          </div>
          <div className="w-12 h-1 bg-gray-300 dark:bg-gray-600 mb-5"></div>
          <div className="flex flex-col items-center">
            {approvedJobCount > 0 ? <CheckCircle2 className="text-green-500 w-8 h-8" /> : <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700" />}
            <span className="text-sm mt-1">Score &amp; Review</span>
          </div>
        </div>
      </div>

      {/* Real-time Evaluation Progress */}
      <EvaluationProgressCard progress={evalProgress} onViewApproved={onNavigateToJobs} />

      {/* Real-time Browser Automation Progress */}
      <AutomationProgressCard progress={autoProgress} onStop={handleStopAutomation} />

      {/* Docs */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <div className="flex items-center mb-2">
          <FileText className="w-5 h-5 mr-2 text-blue-600 dark:text-blue-400" />
          <h2 className="text-lg font-semibold">Master Documents (Source of Truth)</h2>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          The AI uses these as the single source of truth. It will never hallucinate or fabricate information.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border p-4 rounded-md dark:border-gray-700">
            <h3 className="font-medium mb-2">Resume (PDF/DOCX)</h3>
            {docs.resume ? (
              <div className="mb-2">
                <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                  {docs.resume}
                </span>
                <a href={`${API}/api/preview/${docs.resume}`} target="_blank" rel="noreferrer" className="ml-2 text-sm text-blue-600 hover:underline">Preview</a>
              </div>
            ) : (
              <div className="mb-2 inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">Missing</div>
            )}
            <div className="flex space-x-2">
              <input type="file" onChange={(e) => setFileResume(e.target.files?.[0] || null)} className="text-sm w-full" />
              <button onClick={() => handleUpload('resume', fileResume)} className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">Upload</button>
            </div>
          </div>

          <div className="border p-4 rounded-md dark:border-gray-700">
            <h3 className="font-medium mb-2">LinkedIn Export (PDF)</h3>
            {docs.linkedin ? (
              <div className="mb-2">
                <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                  {docs.linkedin}
                </span>
                <a href={`${API}/api/preview/${docs.linkedin}`} target="_blank" rel="noreferrer" className="ml-2 text-sm text-blue-600 hover:underline">Preview</a>
              </div>
            ) : (
              <div className="mb-2 inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">Missing</div>
            )}
            <div className="flex space-x-2">
              <input type="file" onChange={(e) => setFileLinkedin(e.target.files?.[0] || null)} className="text-sm w-full" />
              <button onClick={() => handleUpload('linkedin', fileLinkedin)} className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">Upload</button>
            </div>
          </div>
        </div>

        <hr className="my-6 dark:border-gray-700" />
        <button onClick={handleExtract} disabled={isExtracting || (!docs.resume && !docs.linkedin)} className="w-full py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">
          {isExtracting ? "Analyzing Documents..." : "Extract Candidate Profile from Documents"}
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">AI will analyze your documents and populate your Candidate Profile automatically.</p>
      </div>

      {/* Pipeline */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-blue-50 dark:bg-blue-900/20 p-6 rounded-lg shadow border border-blue-100 dark:border-blue-900">
          <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold mb-4">1</div>
          <h3 className="font-semibold text-lg mb-2">Scrape Jobs</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 h-10">Triggers Apify to scrape LinkedIn for fresh roles matching your profile.</p>
          <button onClick={handleIngest} disabled={isIngesting} className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">
            {isIngesting ? "Scraping..." : "Run Scraper"}
          </button>
        </div>

        <div className="bg-purple-50 dark:bg-purple-900/20 p-6 rounded-lg shadow border border-purple-100 dark:border-purple-900">
          <div className="w-8 h-8 bg-purple-600 text-white rounded-full flex items-center justify-center font-bold mb-4">2</div>
          <h3 className="font-semibold text-lg mb-2">AI Scoring</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 h-10">Scores every scraped job against your resume using the AI Matrix.</p>
          <button onClick={handleEvaluate} disabled={isEvaluating} className="w-full py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50">
            {isEvaluating ? `Scoring (${evalProgress?.current || 0}/${evalProgress?.total || 0})...` : "Run AI Matrix"}
          </button>
        </div>

        <div className="bg-green-50 dark:bg-green-900/20 p-6 rounded-lg shadow border border-green-100 dark:border-green-900">
          <div className="w-8 h-8 bg-green-600 text-white rounded-full flex items-center justify-center font-bold mb-4">3</div>
          <h3 className="font-semibold text-lg mb-2">Launch Browser</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 h-10">Opens Playwright browser for human-in-the-loop application review.</p>
          <button 
            onClick={handleLaunch} 
            disabled={isAutomating || autoProgress?.isRunning}
            className="w-full py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition"
          >
            {isAutomating || autoProgress?.isRunning 
              ? `Browser Active (${autoProgress?.currentIndex || 0}/${autoProgress?.total || 0})...` 
              : "Launch Browser & Review"}
          </button>
        </div>
      </div>
    </div>
  );
};

const JobsTab = () => {
  const [jobs, setJobs] = useState<any[]>([]);
  const [rawJobs, setRawJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"approved" | "raw">("approved");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<string>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [evalProgress, setEvalProgress] = useState<EvaluationProgress | null>(null);
  const [autoProgress, setAutoProgress] = useState<AutomationProgress | null>(null);

  const fetchJobs = async () => {
    try {
      const [aRes, rRes] = await Promise.all([
        fetch(`${API}/api/jobs`),
        fetch(`${API}/api/jobs/raw`)
      ]);
      if (aRes.ok) setJobs(await aRes.json());
      if (rRes.ok) setRawJobs(await rRes.json());
    } catch (e) {
      toast.error("Failed to load jobs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  // Poll automation progress in JobsTab
  useEffect(() => {
    let interval: any = null;
    const checkAuto = async () => {
      try {
        const res = await fetch(`${API}/api/pipeline/apply/progress`);
        if (res.ok) {
          setAutoProgress(await res.json());
        }
      } catch (e) {}
    };
    checkAuto();
    interval = setInterval(checkAuto, 1200);
    return () => clearInterval(interval);
  }, []);

  const handleLaunchBrowser = async () => {
    try {
      const res = await fetch(`${API}/api/pipeline/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false })
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast.success(data.message || "Browser automation started!");
      const pRes = await fetch(`${API}/api/pipeline/apply/progress`);
      if (pRes.ok) {
        setAutoProgress(await pRes.json());
      }
    } catch {
      toast.error("Failed to launch browser automation");
    }
  };

  const handleStopAuto = async () => {
    try {
      await fetch(`${API}/api/pipeline/apply/stop`, { method: 'POST' });
      toast.success("Stopping browser automation...");
    } catch {
      toast.error("Failed to stop automation");
    }
  };

  // Poll evaluation progress and live-update jobs table while running
  useEffect(() => {
    let interval: any = null;
    const checkProgress = async () => {
      try {
        const res = await fetch(`${API}/api/pipeline/evaluate/progress`);
        if (res.ok) {
          const data: EvaluationProgress = await res.json();
          setEvalProgress(data);
          if (data.isRunning) {
            // Silently update jobs in real time
            const [aRes, rRes] = await Promise.all([
              fetch(`${API}/api/jobs`),
              fetch(`${API}/api/jobs/raw`)
            ]);
            if (aRes.ok) setJobs(await aRes.json());
            if (rRes.ok) setRawJobs(await rRes.json());
          }
        }
      } catch (e) {}
    };

    checkProgress();
    interval = setInterval(checkProgress, 1500);
    return () => clearInterval(interval);
  }, []);

  const handleStartEvaluation = async () => {
    try {
      const res = await fetch(`${API}/api/pipeline/evaluate`, { method: 'POST' });
      if (!res.ok) throw new Error("Failed");
      toast.success("AI Scoring started in background");
    } catch (e) {
      toast.error("Failed to start AI Scoring");
    }
  };

  let displayed = viewMode === "approved" ? jobs : rawJobs;

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    displayed = displayed.filter(j => 
      (j.title || "").toLowerCase().includes(q) ||
      (j.company || j.companyName || "").toLowerCase().includes(q) ||
      (j.location || "").toLowerCase().includes(q)
    );
  }

  if (sortField) {
    displayed = [...displayed].sort((a, b) => {
      let va = a[sortField];
      let vb = b[sortField];
      if (sortField === 'company') {
        va = a.company || a.companyName;
        vb = b.company || b.companyName;
      }
      if (sortField === 'score') {
        va = a.matchScore ?? a.score ?? -1;
        vb = b.matchScore ?? b.score ?? -1;
      }
      if (va == null) va = "";
      if (vb == null) vb = "";
      if (typeof va === 'string' && typeof vb === 'string') {
        const cmp = va.localeCompare(vb);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? <ChevronUp className="inline w-4 h-4" /> : <ChevronDown className="inline w-4 h-4" />;
  };

  return (
    <div className="space-y-4">
      {/* Live Automation Progress Card */}
      <AutomationProgressCard progress={autoProgress} onStop={handleStopAuto} />

      {/* Live Evaluation Progress Card */}
      <EvaluationProgressCard progress={evalProgress} />

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow flex flex-col">
        <div className="p-4 border-b dark:border-gray-700 flex flex-col md:flex-row gap-4 justify-between items-center">
          <div className="flex space-x-2 w-full md:w-auto">
            <button onClick={() => setViewMode("approved")} className={`px-4 py-2 rounded-md font-medium text-sm transition ${viewMode === "approved" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>
              AI Approved ({jobs.length})
            </button>
            <button onClick={() => setViewMode("raw")} className={`px-4 py-2 rounded-md font-medium text-sm transition ${viewMode === "raw" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>
              Raw Apify History ({rawJobs.length})
            </button>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:w-64">
              <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
              <input type="text" placeholder="Filter by title, company, location..." className={`${inputCls} pl-9 text-sm`} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>

            <button
              onClick={handleStartEvaluation}
              disabled={evalProgress?.isRunning}
              className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-50 shrink-0 transition"
              title="Run AI evaluation on scraped jobs"
            >
              <Play className="w-4 h-4" />
              {evalProgress?.isRunning ? `Scoring (${evalProgress.current}/${evalProgress.total})...` : "Run AI Matrix"}
            </button>

            <button
              onClick={handleLaunchBrowser}
              disabled={autoProgress?.isRunning}
              className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-50 shrink-0 transition"
              title="Launch browser automation for approved jobs"
            >
              <Play className="w-4 h-4" />
              {autoProgress?.isRunning ? `Browser (${autoProgress.currentIndex}/${autoProgress.total})...` : "Launch Browser"}
            </button>
          </div>
        </div>

        <div className="overflow-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading jobs...</div>
          ) : displayed.length === 0 ? (
            <div className="p-8 flex flex-col items-center justify-center text-gray-500">
              <Filter className="w-12 h-12 mb-4 text-gray-300" />
              <p>No jobs found.</p>
            </div>
          ) : (
            <table className="min-w-full text-sm text-left divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300">
                {viewMode === "approved" ? (
                  <tr>
                    <th className="px-4 py-3 font-medium cursor-pointer" onClick={() => toggleSort('title')}>Job Title <SortIcon field="title"/></th>
                    <th className="px-4 py-3 font-medium cursor-pointer" onClick={() => toggleSort('company')}>Company <SortIcon field="company"/></th>
                    <th className="px-4 py-3 font-medium">Location</th>
                    <th className="px-4 py-3 font-medium cursor-pointer" onClick={() => toggleSort('score')}>Match Score <SortIcon field="score"/></th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                ) : (
                  <tr>
                    <th className="px-4 py-3 font-medium cursor-pointer" onClick={() => toggleSort('title')}>Job Title <SortIcon field="title"/></th>
                    <th className="px-4 py-3 font-medium cursor-pointer" onClick={() => toggleSort('company')}>Company <SortIcon field="company"/></th>
                    <th className="px-4 py-3 font-medium">Location</th>
                    <th className="px-4 py-3 font-medium">Work Type</th>
                    <th className="px-4 py-3 font-medium">Contract</th>
                    <th className="px-4 py-3 font-medium">Experience</th>
                    <th className="px-4 py-3 font-medium">Salary</th>
                    <th className="px-4 py-3 font-medium">Posted</th>
                    <th className="px-4 py-3 font-medium cursor-pointer" onClick={() => toggleSort('score')}>Match Score <SortIcon field="score"/></th>
                    <th className="px-4 py-3 font-medium">Link</th>
                  </tr>
                )}
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {displayed.map((job, idx) => {
                  const id = job.id || String(idx);
                  const isExpanded = expandedJob === id;
                  const scoreVal = job.matchScore ?? job.score;
                  const hasDetails = !!job.aiScoreDetails;

                  return (
                    <React.Fragment key={id}>
                      {viewMode === "approved" ? (
                        <tr 
                          className="hover:bg-gray-50 dark:hover:bg-gray-750 cursor-pointer transition" 
                          onClick={() => setExpandedJob(isExpanded ? null : id)}
                        >
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                            <span className="text-gray-400 text-xs">{isExpanded ? '▼' : '▶'}</span>
                            {job.title}
                          </td>
                          <td className="px-4 py-3">{job.company || job.companyName}</td>
                          <td className="px-4 py-3">{job.location}</td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                              {scoreVal !== undefined ? `${scoreVal}%` : "Scored"}
                            </span>
                          </td>
                          <td className="px-4 py-3 flex items-center gap-1.5">
                            <div className={`w-2 h-2 rounded-full ${job.easyApply ? 'bg-blue-500' : 'bg-purple-500'}`}></div>
                            {job.easyApply ? "Easy Apply" : "External"}
                          </td>
                          <td className="px-4 py-3">
                            <a href={job.url || job.jobUrl} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center" onClick={e => e.stopPropagation()}>
                              View Post <ExternalLink className="w-3 h-3 ml-1" />
                            </a>
                          </td>
                        </tr>
                      ) : (
                        <tr 
                          className={`hover:bg-gray-50 dark:hover:bg-gray-750 transition ${hasDetails ? 'cursor-pointer' : ''}`}
                          onClick={() => hasDetails && setExpandedJob(isExpanded ? null : id)}
                        >
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                            {hasDetails && <span className="text-gray-400 text-xs">{isExpanded ? '▼' : '▶'}</span>}
                            {job.title}
                          </td>
                          <td className="px-4 py-3">{job.companyName || job.company}</td>
                          <td className="px-4 py-3">{job.location}</td>
                          <td className="px-4 py-3">{job.workType || "-"}</td>
                          <td className="px-4 py-3">{job.contractType || "-"}</td>
                          <td className="px-4 py-3">{job.experienceLevel || "-"}</td>
                          <td className="px-4 py-3">{job.salary || "-"}</td>
                          <td className="px-4 py-3">{job.postedTime || job.postedAt || "Unknown"}</td>
                          <td className="px-4 py-3">
                            {scoreVal !== undefined ? (
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full font-medium ${
                                scoreVal >= 80 
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' 
                                  : scoreVal >= 60 
                                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' 
                                  : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                              }`}>
                                {scoreVal}%
                              </span>
                            ) : (
                              <span className="text-gray-400 italic text-xs" title="Run AI Evaluation to score">Not scored</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <a href={job.jobUrl || job.url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={e => e.stopPropagation()}>View</a>
                          </td>
                        </tr>
                      )}

                      {/* Expandable AI Breakdown Row (works for both approved & scored raw jobs) */}
                      {isExpanded && job.aiScoreDetails && (
                        <tr className="bg-gray-50 dark:bg-gray-800/60 border-y dark:border-gray-700">
                          <td colSpan={viewMode === "approved" ? 6 : 10} className="px-6 py-4">
                            <div className="text-sm space-y-3">
                              {job.aiScoreDetails.reasoning && (
                                <p className="italic text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-750 p-3 rounded border dark:border-gray-650">
                                  "{job.aiScoreDetails.reasoning}"
                                </p>
                              )}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="bg-white dark:bg-gray-750 p-3 rounded border dark:border-gray-650">
                                  <strong className="text-green-700 dark:text-green-400 mb-1.5 block flex items-center gap-1">✔ Pros</strong>
                                  <ul className="list-disc pl-4 text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                    {job.aiScoreDetails.pros?.map((p: string, i: number) => <li key={i}>{p}</li>)}
                                  </ul>
                                </div>
                                <div className="bg-white dark:bg-gray-750 p-3 rounded border dark:border-gray-650">
                                  <strong className="text-red-700 dark:text-red-400 mb-1.5 block flex items-center gap-1">✖ Cons</strong>
                                  <ul className="list-disc pl-4 text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                    {job.aiScoreDetails.cons?.map((c: string, i: number) => <li key={i}>{c}</li>)}
                                  </ul>
                                </div>
                                <div className="bg-white dark:bg-gray-750 p-3 rounded border dark:border-gray-650">
                                  <strong className="text-orange-700 dark:text-orange-400 mb-1.5 block flex items-center gap-1">⚠ Missing Skills</strong>
                                  <ul className="list-disc pl-4 text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                    {job.aiScoreDetails.missingSkills?.map((m: string, i: number) => <li key={i}>{m}</li>)}
                                  </ul>
                                </div>
                              </div>
                              {job.aiScoreDetails.subScores && (
                                <div className="flex flex-wrap gap-2 pt-1 text-xs font-mono">
                                  <span className="bg-gray-200 dark:bg-gray-700 px-2.5 py-1 rounded text-gray-800 dark:text-gray-200">
                                    Tech Stack: {job.aiScoreDetails.subScores.coreTechnicalStack ?? job.aiScoreDetails.subScores.techStack ?? 0}%
                                  </span>
                                  <span className="bg-gray-200 dark:bg-gray-700 px-2.5 py-1 rounded text-gray-800 dark:text-gray-200">
                                    Seniority: {job.aiScoreDetails.subScores.seniorityAlignment ?? job.aiScoreDetails.subScores.seniority ?? 0}%
                                  </span>
                                  <span className="bg-gray-200 dark:bg-gray-700 px-2.5 py-1 rounded text-gray-800 dark:text-gray-200">
                                    Domain: {job.aiScoreDetails.subScores.domainRelevance ?? job.aiScoreDetails.subScores.domain ?? 0}%
                                  </span>
                                  <span className="bg-gray-200 dark:bg-gray-700 px-2.5 py-1 rounded text-gray-800 dark:text-gray-200">
                                    Bonus: {job.aiScoreDetails.subScores.bonusSkills ?? job.aiScoreDetails.subScores.bonus ?? 0}%
                                  </span>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

const CandidateProfileTab = () => {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);
  const [docs, setDocs] = useState<{resume?: string, linkedin?: string}>({});

  const fetchAll = async () => {
    try {
      const [pRes, dRes] = await Promise.all([
        fetch(`${API}/api/profile`),
        fetch(`${API}/api/documents`)
      ]);
      if (pRes.ok) setProfile(await pRes.json());
      if (dRes.ok) setDocs(await dRes.json());
    } catch (e) {
      toast.error("Failed to load profile");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const handleExtract = async () => {
    setIsExtracting(true);
    try {
      const res = await fetch(`${API}/api/pipeline/extract-profile`, { method: 'POST' });
      if (!res.ok) throw new Error("Failed");
      toast.success("Profile extracted");
      fetchAll();
    } catch (e) {
      toast.error("Extraction failed");
    } finally {
      setIsExtracting(false);
    }
  };

  const handleSave = async () => {
    try {
      const res = await fetch(`${API}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      });
      if (!res.ok) throw new Error("Failed");
      toast.success("Profile saved");
    } catch (e) {
      toast.error("Failed to save profile");
    }
  };

  const updateProfile = (section: string, field: string, value: any) => {
    setProfile((prev: any) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value
      }
    }));
  };

  if (loading || !profile) return <div className="p-8 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between bg-white dark:bg-gray-800 p-6 rounded-lg shadow gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center">
            Candidate Profile
            {profile.raw_extracted ? (
              <span className="ml-3 text-xs font-medium px-2.5 py-1 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 rounded-full">Extracted from resume</span>
            ) : (
              <span className="ml-3 text-xs font-medium px-2.5 py-1 bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 rounded-full">Not yet extracted</span>
            )}
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">AI-extracted from your documents. Review and edit any fields below.</p>
        </div>
        <div className="flex space-x-3">
          <button onClick={handleExtract} disabled={isExtracting || (!docs.resume && !docs.linkedin)} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">
            {isExtracting ? "Extracting..." : "Extract from Documents"}
          </button>
          <button onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
            Save Profile
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Target Job Search</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Job Titles (comma separated)</label>
            <input type="text" value={profile.search?.titles?.join(", ") || ""} onChange={e => updateProfile('search', 'titles', e.target.value.split(",").map(s => s.trim()).filter(Boolean))} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Locations (comma separated)</label>
            <input type="text" value={profile.search?.locations?.join(", ") || ""} onChange={e => updateProfile('search', 'locations', e.target.value.split(",").map(s => s.trim()).filter(Boolean))} className={inputCls} />
          </div>
        </div>
        <p className="text-xs text-gray-500">These are used by the Apify scraper when searching for jobs.</p>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Personal Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Phone</label>
            <input type="text" value={profile.personal_info?.phone || ""} onChange={e => updateProfile('personal_info', 'phone', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" value={profile.personal_info?.email || ""} onChange={e => updateProfile('personal_info', 'email', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">City</label>
            <input type="text" value={profile.personal_info?.city || ""} onChange={e => updateProfile('personal_info', 'city', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Professional</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Salary Expectation</label>
            <input type="text" value={profile.professional?.salary_expectation || ""} onChange={e => updateProfile('professional', 'salary_expectation', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Years of Experience</label>
            <input type="text" value={profile.professional?.years_of_experience || ""} onChange={e => updateProfile('professional', 'years_of_experience', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Notice Period</label>
            <input type="text" value={profile.professional?.notice_period || ""} onChange={e => updateProfile('professional', 'notice_period', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Education</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Degree</label>
            <input type="text" value={profile.education?.degree || ""} onChange={e => updateProfile('education', 'degree', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">University</label>
            <input type="text" value={profile.education?.university || ""} onChange={e => updateProfile('education', 'university', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">GPA</label>
            <input type="text" value={profile.education?.gpa || ""} onChange={e => updateProfile('education', 'gpa', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Graduation Year</label>
            <input type="text" value={profile.education?.graduation_year || ""} onChange={e => updateProfile('education', 'graduation_year', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Links &amp; Portfolio</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">LinkedIn Profile</label>
            <input type="text" value={profile.links?.linkedin_profile || ""} onChange={e => updateProfile('links', 'linkedin_profile', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Portfolio Website</label>
            <input type="text" value={profile.links?.portfolio_website || ""} onChange={e => updateProfile('links', 'portfolio_website', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">GitHub</label>
            <input type="text" value={profile.links?.github || ""} onChange={e => updateProfile('links', 'github', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Demographics &amp; Compliance</h2>
        <p className="text-xs text-gray-500 mb-2">Provide any values you'd like (e.g. "Prefer not to say", "Indian", "Male"). The AI will parse these exactly as written.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {profile.compliance && Object.keys(profile.compliance).map(key => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1 capitalize">{key.replaceAll('_', ' ')}</label>
              <input
                type="text"
                placeholder="e.g. Prefer not to say"
                value={profile.compliance?.[key] || ""} 
                onChange={e => updateProfile('compliance', key, e.target.value)}
                className={inputCls}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const SettingsTab = () => {
  const [data, setData] = useState<any>(null);
  const [blacklist, setBlacklist] = useState<{companies: string[], keywords: string[]}>({companies: [], keywords: []});
  const [loading, setLoading] = useState(true);
  const [newCompany, setNewCompany] = useState("");
  const [newKeyword, setNewKeyword] = useState("");

  const fetchData = async () => {
    try {
      const [sRes, bRes] = await Promise.all([
        fetch(`${API}/api/settings`),
        fetch(`${API}/api/blacklist`)
      ]);
      if (sRes.ok) setData(await sRes.json());
      if (bRes.ok) setBlacklist(await bRes.json());
    } catch (e) {
      toast.error("Failed to fetch settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSave = async () => {
    try {
      const [sRes, bRes] = await Promise.all([
        fetch(`${API}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: data.settings, keys: data.keys })
        }),
        fetch(`${API}/api/blacklist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(blacklist)
        })
      ]);
      if (!sRes.ok || !bRes.ok) throw new Error("Save failed");
      toast.success("Settings saved");
    } catch (e) {
      toast.error("Failed to save settings");
    }
  };

  const updateKeys = (field: string, val: string) => setData((p: any) => ({...p, keys: {...p.keys, [field]: val}}));
  const updateAi = (field: string, val: any) => setData((p: any) => ({...p, settings: {...p.settings, ai: {...p.settings.ai, [field]: val}}}));
  const updateApify = (field: string, val: any) => setData((p: any) => ({...p, settings: {...p.settings, ingestion: {...p.settings.ingestion, apify_input: {...p.settings.ingestion.apify_input, [field]: val}}}}));
  const updateWeights = (field: string, val: any) => setData((p: any) => ({...p, settings: {...p.settings, evaluation_weights: {...p.settings.evaluation_weights, [field]: Number(val)}}}));

  const handleArrayToggle = (field: string, value: string, checked: boolean) => {
    const current = data.settings.ingestion.apify_input[field] || [];
    let next;
    if (checked) next = [...current, value];
    else next = current.filter((v: string) => v !== value);
    updateApify(field, next);
  };

  if (loading || !data) return <div className="p-8 text-center">Loading...</div>;

  const weightsSum = 
    (data.settings.evaluation_weights?.core_technical_stack || 0) +
    (data.settings.evaluation_weights?.seniority_alignment || 0) +
    (data.settings.evaluation_weights?.domain_relevance || 0) +
    (data.settings.evaluation_weights?.bonus_skills || 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <h1 className="text-2xl font-bold">Settings &amp; Configuration</h1>
        <button onClick={handleSave} className="mt-4 md:mt-0 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Save All Changes</button>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">API Credentials</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Gemini API Keys (Comma separated)</label>
            <input type="password" value={data.keys?.gemini || ""} onChange={e => updateKeys('gemini', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">OpenRouter API Keys</label>
            <input type="password" value={data.keys?.openrouter || ""} onChange={e => updateKeys('openrouter', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Apify API Token</label>
            <input type="password" value={data.keys?.apify || ""} onChange={e => updateKeys('apify', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">AI Engine</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Provider</label>
            <select value={data.settings?.ai?.provider || "gemini"} onChange={e => updateAi('provider', e.target.value)} className={inputCls}>
              <option value="gemini">Gemini</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Model</label>
            {data.settings?.ai?.provider === "openrouter" ? (
              <>
                <select value={["google/gemini-2.5-flash-free","meta-llama/llama-3.3-70b-instruct:free","deepseek/deepseek-r1:free","qwen/qwen-2.5-72b-instruct:free","microsoft/phi-3-medium-128k-instruct:free","mistralai/mistral-7b-instruct:free"].includes(data.settings?.ai?.model) ? data.settings.ai.model : "__custom__"} onChange={e => { if (e.target.value !== "__custom__") updateAi('model', e.target.value); else updateAi('model', ''); }} className={inputCls}>
                  <option value="google/gemini-2.5-flash-free">google/gemini-2.5-flash-free (Recommended)</option>
                  <option value="meta-llama/llama-3.3-70b-instruct:free">meta-llama/llama-3.3-70b-instruct:free</option>
                  <option value="deepseek/deepseek-r1:free">deepseek/deepseek-r1:free</option>
                  <option value="qwen/qwen-2.5-72b-instruct:free">qwen/qwen-2.5-72b-instruct:free</option>
                  <option value="microsoft/phi-3-medium-128k-instruct:free">microsoft/phi-3-medium-128k-instruct:free</option>
                  <option value="mistralai/mistral-7b-instruct:free">mistralai/mistral-7b-instruct:free</option>
                  <option value="__custom__">Custom model ID...</option>
                </select>
                {!["google/gemini-2.5-flash-free","meta-llama/llama-3.3-70b-instruct:free","deepseek/deepseek-r1:free","qwen/qwen-2.5-72b-instruct:free","microsoft/phi-3-medium-128k-instruct:free","mistralai/mistral-7b-instruct:free"].includes(data.settings?.ai?.model || "") && (
                  <input type="text" placeholder="e.g. openai/gpt-4o-mini" value={data.settings?.ai?.model || ""} onChange={e => updateAi('model', e.target.value)} className={inputCls + " mt-2"} />
                )}
                <p className="text-xs text-gray-400 mt-1">Browse models at <a href="https://openrouter.ai/models?q=:free" target="_blank" className="text-blue-500 underline">openrouter.ai/models</a></p>
              </>
            ) : (
              <select value={data.settings?.ai?.model || "gemini-3.6-flash"} onChange={e => updateAi('model', e.target.value)} className={inputCls}>
                <option value="gemini-3.6-flash">gemini-3.6-flash (Fast & Recommended)</option>
                <option value="gemini-3.7-flash">gemini-3.7-flash</option>
                <option value="gemini-flash-latest">gemini-flash-latest</option>
                <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Max Approved Jobs per Run</label>
            <input type="number" value={data.settings?.ai?.max_approved_jobs || 10} onChange={e => updateAi('max_approved_jobs', Number(e.target.value))} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Match Threshold</label>
            <input type="number" min="0" max="100" value={data.settings?.evaluation_weights?.match_threshold || 80} onChange={e => updateWeights('match_threshold', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Apify Scraper Configuration</h2>
        <p className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 p-2 rounded">Job titles and locations are pulled from your Candidate Profile, not configured here.</p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Max Jobs to Scrape</label>
            <input type="number" value={data.settings?.ingestion?.apify_input?.rows || 50} onChange={e => updateApify('rows', Number(e.target.value))} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Date Posted</label>
            <select value={data.settings?.ingestion?.apify_input?.publishedAt || ""} onChange={e => updateApify('publishedAt', e.target.value)} className={inputCls}>
              <option value="r86400">Past 24h</option>
              <option value="r604800">Past Week</option>
              <option value="r2592000">Past Month</option>
              <option value="">Any Time</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Sort By</label>
            <select value={data.settings?.ingestion?.apify_input?.sortBy || "recent"} onChange={e => updateApify('sortBy', e.target.value)} className={inputCls}>
              <option value="recent">Most Recent</option>
              <option value="relevant">Most Relevant</option>
            </select>
          </div>
          <div className="flex items-center h-full pt-6">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input type="checkbox" checked={!!data.settings?.ingestion?.apify_input?.easyApply} onChange={e => updateApify('easyApply', e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4" />
              <span className="text-sm font-medium">Easy Apply Only</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
          <div>
            <h3 className="font-medium mb-2 text-sm">Work Type</h3>
            <div className="space-y-2">
              {[
                {label: 'On-site', val: '1'},
                {label: 'Remote', val: '2'},
                {label: 'Hybrid', val: '3'}
              ].map(opt => (
                <label key={opt.val} className="flex items-center space-x-2">
                  <input type="checkbox" checked={data.settings?.ingestion?.apify_input?.workTypes?.includes(opt.val) || false} onChange={e => handleArrayToggle('workTypes', opt.val, e.target.checked)} className="rounded" />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-medium mb-2 text-sm">Contract Type</h3>
            <div className="space-y-2">
              {[
                {label: 'Full-time', val: 'F'},
                {label: 'Part-time', val: 'P'},
                {label: 'Contract', val: 'C'},
                {label: 'Temporary', val: 'T'},
                {label: 'Internship', val: 'I'}
              ].map(opt => (
                <label key={opt.val} className="flex items-center space-x-2">
                  <input type="checkbox" checked={data.settings?.ingestion?.apify_input?.contractTypes?.includes(opt.val) || false} onChange={e => handleArrayToggle('contractTypes', opt.val, e.target.checked)} className="rounded" />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-medium mb-2 text-sm">Experience Level</h3>
            <div className="space-y-2">
              {[
                {label: 'Internship', val: '1'},
                {label: 'Entry Level', val: '2'},
                {label: 'Associate', val: '3'},
                {label: 'Mid-Senior', val: '4'},
                {label: 'Director', val: '5'},
                {label: 'Executive', val: '6'}
              ].map(opt => (
                <label key={opt.val} className="flex items-center space-x-2">
                  <input type="checkbox" checked={data.settings?.ingestion?.apify_input?.experienceLevels?.includes(opt.val) || false} onChange={e => handleArrayToggle('experienceLevels', opt.val, e.target.checked)} className="rounded" />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Blacklist Management</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="font-medium mb-2 text-sm">Blocked Companies</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {blacklist.companies.map(c => (
                <span key={c} className="inline-flex items-center px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-sm">
                  {c}
                  <button onClick={() => setBlacklist(b => ({...b, companies: b.companies.filter(x => x !== c)}))} className="ml-1 text-gray-500 hover:text-red-500"><X className="w-3 h-3"/></button>
                </span>
              ))}
            </div>
            <div className="flex space-x-2">
              <input type="text" value={newCompany} onChange={e => setNewCompany(e.target.value)} className={inputCls} placeholder="Add company..." />
              <button onClick={() => { if(newCompany) { setBlacklist(b => ({...b, companies: [...b.companies, newCompany]})); setNewCompany(""); } }} className="px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 text-sm">Add</button>
            </div>
          </div>

          <div>
            <h3 className="font-medium mb-2 text-sm">Blocked Keywords</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {blacklist.keywords.map(k => (
                <span key={k} className="inline-flex items-center px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-sm">
                  {k}
                  <button onClick={() => setBlacklist(b => ({...b, keywords: b.keywords.filter(x => x !== k)}))} className="ml-1 text-gray-500 hover:text-red-500"><X className="w-3 h-3"/></button>
                </span>
              ))}
            </div>
            <div className="flex space-x-2">
              <input type="text" value={newKeyword} onChange={e => setNewKeyword(e.target.value)} className={inputCls} placeholder="Add keyword..." />
              <button onClick={() => { if(newKeyword) { setBlacklist(b => ({...b, keywords: [...b.keywords, newKeyword]})); setNewKeyword(""); } }} className="px-3 py-2 bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 text-sm">Add</button>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h2 className="text-lg font-semibold">Evaluation Weights</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Core Technical Stack</label>
            <input type="number" value={data.settings?.evaluation_weights?.core_technical_stack || 0} onChange={e => updateWeights('core_technical_stack', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Seniority Alignment</label>
            <input type="number" value={data.settings?.evaluation_weights?.seniority_alignment || 0} onChange={e => updateWeights('seniority_alignment', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Domain Relevance</label>
            <input type="number" value={data.settings?.evaluation_weights?.domain_relevance || 0} onChange={e => updateWeights('domain_relevance', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Bonus Skills</label>
            <input type="number" value={data.settings?.evaluation_weights?.bonus_skills || 0} onChange={e => updateWeights('bonus_skills', e.target.value)} className={inputCls} />
          </div>
        </div>
        <p className={`font-medium ${weightsSum === 100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          Sum: {weightsSum}/100
        </p>
      </div>
    </div>
  );
};

export default function App() {
  const [isDark, setIsDark] = useState(() => {
    return localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  const [activeTab, setActiveTab] = useState("orchestrator");

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  const tabs = [
    { key: "orchestrator", label: "Orchestrator", icon: Play },
    { key: "jobs", label: "Job Review", icon: CheckCircle2 },
    { key: "profile", label: "Candidate Profile", icon: FileText },
    { key: "settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 overflow-hidden">
      <Toaster position="top-right" />
      
      {/* Sidebar */}
      <div className="w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
          <img src={JobJetLogo} alt="Job Jet Logo" className="w-8 h-8 object-contain" />
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400">
            Job Jet
          </h1>
        </div>
        
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`w-full flex items-center px-4 py-3 text-sm rounded-md transition-colors ${
                  active 
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium" 
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                <Icon className={`w-5 h-5 mr-3 ${active ? "text-blue-700 dark:text-blue-400" : "text-gray-400 dark:text-gray-500"}`} />
                {tab.label}
              </button>
            );
          })}
        </nav>
        
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <button 
            onClick={() => setIsDark(!isDark)}
            className="flex items-center justify-center w-full px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
          >
            {isDark ? <Sun className="w-5 h-5 mr-2" /> : <Moon className="w-5 h-5 mr-2" />}
            {isDark ? "Light Mode" : "Dark Mode"}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-6xl mx-auto h-full">
          {activeTab === "orchestrator" && <OrchestratorTab onNavigateToJobs={() => setActiveTab("jobs")} />}
          {activeTab === "jobs" && <JobsTab />}
          {activeTab === "profile" && <CandidateProfileTab />}
          {activeTab === "settings" && <SettingsTab />}
        </div>
      </div>
    </div>
  );
}
