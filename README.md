# Job Jet 🚀
### AI-Augmented LinkedIn Easy Apply Orchestrator with Multi-Tab Review

Job Jet is an intelligent job search and application tool that automates the tedious parts of applying to jobs on LinkedIn while keeping you firmly in control.

It scrapes relevant job listings, uses AI (Gemini or OpenRouter) to evaluate and score match quality against your master resume, pre-fills LinkedIn Easy Apply applications using human-mimicking browser automation, and **leaves pre-filled application tabs open for your final 1-click review and submission**.

---

## ✨ Features

- **Document Source of Truth**: Upload your resume and LinkedIn PDF export. Job Jet extracts your structured profile and strictly uses it to answer application questions with zero hallucinations.
- **Automated LinkedIn Ingestion**: Pulls live job postings matching your target titles and locations via Apify.
- **AI Match Scoring**: Multi-factor scoring (technical stack, seniority alignment, domain relevance, bonus skills) with customizable threshold filters.
- **Multiple API Keys & Automatic Failover**: Configure multiple Gemini or OpenRouter API keys in the Settings tab. If one key hits a rate limit or runs out of credits, Job Jet automatically switches to the next.
- **Humanized Browser Automation**:
  - Realistic typing cadence and keystroke delays.
  - Organic cooldowns between job applications to respect LinkedIn safety limits.
  - Automatic country code selection and national phone number formatting.
- **Multi-Tab Preparation Workflow**: The bot does all the heavy lifting in separate browser tabs up to the final "Review / Submit application" screen and leaves them open on your desktop, ready for your 1-click submission.
- **One-Click Launcher (`run.bat`)**: Zero terminal setup required for non-technical users. Just double-click `run.bat` and the app sets up and opens in your browser.

---

## 🛠️ Prerequisites

- **[Node.js](https://nodejs.org/)** (v20.0.0 or higher)
- **Google Chrome** (recommended for seamless desktop automation)
- API Keys:
  - **Gemini API Key** (Free tier available at [Google AI Studio](https://aistudio.google.com/apikey)) or **OpenRouter API Key** (Supports free models at [openrouter.ai](https://openrouter.ai/keys))
  - **Apify API Token** (Free tier available at [apify.com](https://apify.com/))

---

## 🚀 Quick Start (Windows)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/imrealSpidey/job-jet.git
   cd job-jet
   ```

2. **Launch the application:**
   - Double-click **`run.bat`**.
   - The launcher will automatically verify Node.js, install all backend and frontend dependencies, ensure the browser drivers are downloaded, start the services, and open the dashboard in your default browser at **http://localhost:5173**.

3. **Configure your API Keys:**
   - Navigate to the **Settings** tab in the dashboard.
   - Enter your Gemini or OpenRouter API key(s) and Apify API token.
   - Click **Save Settings**.

---

## 💻 Manual Setup (macOS / Linux / Windows CLI)

If you prefer running via the command line:

1. **Install dependencies:**
   ```bash
   npm install
   cd ui && npm install && cd ..
   npx playwright install chromium
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your API keys, or configure them later through the web dashboard.

3. **Start the application:**
   ```bash
   npm start
   ```
   Open **http://localhost:5173** in your browser.

---

## 🔒 Privacy & Safety Notice

- **Your data stays local**: Your resume, LinkedIn profile, job applications, and API keys are stored solely on your local machine and are never shared or sent to any third-party server other than the AI provider you select for evaluation.
- **Human-in-the-Loop**: Job Jet never clicks the final "Submit" button automatically. It pre-fills and stages applications across tabs for you to inspect and submit yourself.
