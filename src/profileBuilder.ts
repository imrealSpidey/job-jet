import { type CandidateProfile, type Settings } from "./types.js";
import { generateStructuredResponse, getModelForTask } from "./ai.js";

export async function extractCandidateProfile(resumeText: string, settings: Settings): Promise<Partial<CandidateProfile>> {
  const { config: aiConfig, apiKeys, fallbackConfig, fallbackApiKeys } = getModelForTask(settings, "extraction");
  
  if (apiKeys.length === 0 && (!fallbackApiKeys || fallbackApiKeys.length === 0)) {
    throw new Error(`No API keys available for profile extraction (${aiConfig.provider}). Please configure keys in Settings.`);
  }

  const systemPrompt = `
You are an expert technical recruiter and data extractor. 
I am providing you with a raw candidate resume text.
Your job is to extract the candidate's profile data into a strict JSON format.

If you CANNOT confidently infer a field from the text, return null for that field. Do NOT guess personal details like ethnicity, visa status, or GPA if they are not explicitly mentioned.

For 'search.titles', infer the top 3 most likely job titles they are applying for based on their experience.
For 'search.locations', infer the top 2 locations they might be looking for (e.g. current city, "Remote", or general country).

The output MUST be a raw JSON object with this exact schema:
{
  "search": { "titles": ["str"], "locations": ["str"] },
  "personal_info": { "phone": "str|null", "email": "str|null", "city": "str|null" },
  "professional": { "salary_expectation": "str|null", "years_of_experience": "str|null", "notice_period": "str|null" },
  "links": { "linkedin_profile": "str|null", "portfolio_website": "str|null", "github": "str|null" },
  "education": { "degree": "str|null", "university": "str|null", "gpa": "str|null", "graduation_year": "str|null" },
  "compliance": {
    "visa_sponsorship": "str|null",
    "work_authorization": "str|null",
    "gender": "str|null",
    "race_ethnicity": "str|null",
    "veteran_status": "str|null",
    "disability_status": "str|null"
  }
}
`;

  try {
    const parsed = await generateStructuredResponse(
      aiConfig,
      apiKeys,
      systemPrompt,
      resumeText,
      fallbackConfig,
      fallbackApiKeys
    );
    parsed.raw_extracted = true;
    return parsed;
  } catch (error: any) {
    console.error("Failed to extract candidate profile:", error);
    throw new Error("AI extraction failed: " + error.message);
  }
}
