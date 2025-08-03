// services/content-safety.js
/**
 * Enterprise-grade Content Safety System
 * * Features:
 * - Multi-layered pattern matching with complexity analysis
 * - Advanced obfuscation detection (leetspeak, unicode, spacing, etc.)
 * - Context-aware analysis with sliding windows
 * - Multilingual harmful content detection
 * - Behavioral pattern recognition
 * - Performance optimized with caching and early exits
 * - Comprehensive logging and metrics
 * - Configurable severity thresholds
 * * @version 2.5.2 (Patched)
 * @license GPL
 */

import { NaiveBayesClassifier } from './naive-bayes-classifier.js';
import { MarkovChainClassifier } from './markov-chain-classifier.js'; 


export class ContentSafetySystem {
  constructor(config = {}) {
    // Configuration
    this.config = {
      maxTextLength: config.maxTextLength || 10000,
      cacheSize: config.cacheSize || 1000,
      enableMetrics: config.enableMetrics !== false,
      enableContextAnalysis: config.enableContextAnalysis !== false,
      customPatterns: config.customPatterns || {},
      severityThresholds: {
        critical: 1.0,
        high: 0.8,
        medium: 0.6,
        low: 0.4,
        ...config.severityThresholds
      },
       // If the model is >90% sure something is not_safe, it can influence the decision.
      nbcBlockThreshold: config.nbcBlockThreshold || 0.90
    };
    
    // Performance cache
    this.cache = new Map();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    
    // Metrics
    this.metrics = {
      totalChecks: 0,
      blockedContent: 0,
      detectionsByCategory: new Map(),
      averageCheckTime: 0,
      obfuscationAttempts: 0
    };
    
    // Initialize pattern database
    this.initializePatterns();
    
    // Pre-compile all regex patterns for performance
    this.compiledPatterns = this.compilePatterns();

   // Initialize and load the pre-trained Naive Bayes Classifier model.
    this.classifier = new NaiveBayesClassifier();
    this.classifier.loadModel();

    // Initialize and load the pre-trained Markov Chain Classifier model.
    this.markovClassifier = new MarkovChainClassifier();
    this.markovClassifier.loadModel(); 

    // Initialize normalizers
    this.initializeNormalizers();
  }
  
  initializePatterns() {
    // Critical harm patterns - immediate threats to safety
    this.harmPatterns = {
      critical: {
        // Child safety - highest priority
        csam: {
          patterns: [
            /(cp|csam|csa|child[\s_-]*(porn|sex|abuse|exploitation)|child\s*sexual\s*abuse)/i,
            /\b(pedo|paedo|p3do|ped0|map|pthc)\b/i,
            /(lo+l+i+|shota|cub|toddlercon|babycon|prete?en|under[-\s]*age|jail\s*bait)/i,
            /(minor|kid|child)[\s\S]{0,25}(sex|nude|porn|pics?|vids?|naked|rape|abuse)/i,
            /\d{1,2}\s*(yo|yrs?|year[-\s]*old)[\s\S]{0,25}(nudes?|sex|porn|pics?|vids?)/i,
            /(toddler|infant|baby)[\s\S]{0,25}(sex|abuse|rape|molest)/i,
            /(she|he|they)\s*(is|are)\s*(a|an)?\s*(underage|minor|child|kid)\s*(girl|boy|child)?/i
          ],
          contextRules: {
            requiresContext: false,
            falsePositiveKeywords: ['report', 'news', 'arrest', 'convicted']
          }
        },
        
        // Imminent violence/terrorism
        terrorism: {
          patterns: [
            /(make|build|assemble|cook|mix|prepare)[\s\S]{0,30}(bomb|ied|pipe[\s_-]*bomb|molotov|napalm|explosive|device|detonator)/i,
            /(terror|terrorist|extremist|jihad)[\s\S]{0,25}(attack|plan|manual|guide|training|recruit|cell)/i,
            /(isis|daesh|al[-\s]*qaeda|taliban|al[-\s]*shabaab|hamas|hezbollah)[\s\S]{0,25}(join|contact|pledge|bayat|support)/i,
            /(suicide|mass|school|car|truck|church|synagogue)[\s\S]{0,20}(bomb|attack|shoot(?:ing)?|massacre)/i,
            /(how\s*to|guide|tutorial|recipe)[\s\S]{0,25}(make|build|synthesize)[\s\S]{0,25}(ricin|sarin|anthrax|chloroform|tnt|black\s*powder|nitro(?:glycerin)?)/i,
            /how\s+to.{0,20}(bomb|poison|kill\s+many)/i,
            /(?:how\s*to\s*)?(?:make|build|create|construct)\s*(?:a\s*)?b[o0]m[b8]/i,
            /(ricin|sarin|anthrax).{0,20}(make|create|obtain)/i,
            /(blueprint|schematic|formula)[\s\S]{0,25}(bomb|weapon|explosive)/i
          ],
          contextRules: {
            requiresContext: true,
            exceptions: ['news', 'history', 'fiction', 'game', 'movie', 'creative'], 
            falsePositiveKeywords: ['movie', 'film', 'character', 'scene', 'plot', 'story'] 
          }
        },
        
        // Doxxing/Privacy violations
        doxxing: {
          patterns: [
            /(dox+x?ing?|swat(?:ting)?|drop(?:pin[g]?|ping)?\s*docs?)/i,
            /(real|home|personal|private|current|exact)\s*(address|add\.?|location|loc|coords?)/i,
            /(leak(?:ed)?|reveal(?:ed)?|expose(?:d)?|publish(?:ed)?)[\s\S]{0,20}(address|phone|number|email|info|docs?)/i,
            /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/, // SSN
            /(?:\+?1\s*[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/, // Phone Number
            /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // Email
            /\b\d{1,5}\s+[\w\s]{1,50}\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|plaza|blvd)\b/i,
            /\b(apt|apartment|unit|suite|#)\s*\d+\b/i,
            /\b\d{5}(?:-\d{4})?\b/, // ZIP code
            /\b(lat|latitude|long|longitude)\s*:?\s*-?\d+\.\d+\b/i
          ],
           contextRules: {
             requiresContext: true,
             mustInclude: ['address', 'street', 'location', 'zip', 'city', 'state', 'phone', 'email', 'ssn', 'coordinates']
           }
        }
      },
      
      high: {
        // Direct threats
        threats: {
          patterns: [
            /(k[i!ι1]ll|khyll|murder|slaughter|eliminate|erase|shoot|stab|strangle|decapitate|behead|burn|torch).{0,25}(you|u|ur|ya|your|family|kin|kids)/i,
            /(i['’]m\s*going\s*to|i\s*will|gonna|about\s*to|fixin(?:g)?\s*to).{0,25}(kill|hurt|beat|break|mess\s*you\s*up|ruin|destroy|shoot)/i,
            /(you['’]ll|you\s*will|you['’]re\s*going\s*to).{0,25}(die|bleed|suffer|pay|regret)/i,
            /(find|track|hunt|locate|trace).{0,25}(you|u|ya).{0,25}(down|irl|soon|tonight)/i,
            /watch.{0,20}(your|ur).{0,20}back/i,
            /(burn|firebomb).{0,25}(house|home|car)/i,
            /(fuck|rape|sexual(?:ly)?\sassault).{0,25}(you|ya|ur|your)/i
          ],
          contextRules: {
            intensifiers: ['definitely', 'literally', 'actually', 'really'],
            mitigators: ['game', 'movie', 'book', 'joke', 'meme'],
            neverMitigate: true
          }
        },
        
        // Self-harm
        selfharm: {
          patterns: [
            /(kill|end|take).{0,20}(myself|my\s*life|own\s*life)/i,
            /(cut|harm|hurt).{0,20}(myself|self)/i,
            /suicid(e|al)/i,
            /(want|going|planning).{0,20}die/i,
            /(method|way|how).{0,20}(suicide|kill\s*myself)/i,
            /(bridge|cliff|building).{0,20}(jump|leap)/i,
            /(overdose|od|pills).{0,20}(take|swallow)/i,
            /(kys|kill\s*yourself|end\s*yourself)/i, 
            /best\s*way\s*to\s*(end\s*it|die|suicide)/i,
            /which\s*(pills?|drugs?|method).*\b(fastest|quickest|best)/i,
            /life\s*(isn't|not)\s*worth\s*living/i,
            /un[a4]l[i1]v[e3]/i,  // "unalive" euphemism
            /planning\s*to\s*(od|overdose)/i,
            /which\s*(pills?|drugs?)\s*work\s*fastest/i,
          ],
          contextRules: {
            supportPhrases: ['help', 'hotline', 'support', 'prevention'],
            requiresPersonalContext: true
          }
        },

        grooming_behavior: {
          patterns: [
            /looking\s*for\s*(young|little)\s*(girls?|boys?)\s*to\s*(chat|talk|meet)/i,
            /\b(netflix\s*and\s*ch[i!]ll|date|meet)\s*with\s*(someone\s*)?(under\s*18|minor|underage)/i,
          ],
          contextRules: {
            requiresContext: false
          }
        },

        // Illegal markets
        illegal_trade: {
          patterns: [
            /(sell|buy|deal).{0,20}(meth|cocaine|heroin|fentanyl|mdma|lsd)/i,
            /(drug|narcotics).{0,20}(dealer|supplier|plug)/i,
            /(weapon|gun|firearm).{0,20}(sell|buy|illegal)/i,
            /(fake|forged).{0,20}(passport|id|document)/i,
            /(credit\s*card|cc).{0,20}(dump|fullz|cvv)/i,
            /(hitman|assassin|killer).{0,20}(hire|need|contact)/i,
            /dark\s*web.{0,20}(market|vendor|link)/i,
            /(hitman|assassin|killer)\s*(for\s*)?(hire|need|wanted|available)/i,
            /s[3e]ll[1i]ng\s*w[3e][3e]d/i,
            /c[0o]k[3e]/i,
            /(hitman|assassin|killer)\s*(for\s*)?(hire|need|wanted|available|serious\s*job)/i,
          ],
          contextRules: {
            transactionWords: ['bitcoin', 'crypto', 'payment', 'escrow', 'ship']
          }
        },
        
        financial_scams: {
          patterns: [
            /(wire|send|transfer)\s*(money|funds|bitcoin|crypto)/i,
            /(nigerian?\s*prince|inheritance|lottery\s*win)/i,
            /your\s*(account|card)\s*(has\s*been|was)\s*(compromised|hacked)/i,
            /click\s*here\s*to\s*(verify|confirm|secure)/i,
            /(irs|tax)\s*(fraud|evasion|warrant)/i,
            /gift\s*card\s*(payment|number|code)/i
          ],
          contextRules: {
            requiresContext: true,
            transactionWords: ['payment', 'urgent', 'immediately', 'expire']
          }
        },

        sextortion: {
          patterns: [
            /i\s*have\s*(your|compromising)\s*(video|photos?|pictures?)/i,
            /(pay|send)\s*(me|bitcoin|money)\s*or\s*i['ll\s]*(share|post|send)/i,
            /your\s*(webcam|camera)\s*was\s*(hacked|compromised)/i,
            /i\s*know\s*your\s*password/i,
            /(share|send)\s*this\s*to\s*(your|all)\s*(contacts|friends|family)/i
          ],
          contextRules: {
            requiresContext: true,
            threatIndicators: ['bitcoin', 'payment', 'hours', 'deadline']
          }
        }
        
      },
      
      medium: {
        // Hate speech with context
        hate_speech: {
          patterns: [
            /(nigger|nigga|n\*{4}r|faggot|fag|kike|spic|chink|gook|wetback|towelhead|tranny|slut|whore|bitch|cunt|skag|skank|nigg|niggs|nigs|poof|poofter|poofta)/i,
            /(all|every).{0,20}(blacks|whites|jews|muslims|christians|gays|hindus|indians|africans).{0,20}(should|must|need)/i,
            /(holocaust|slavery).{0,20}(good|deserved|fake|hoax)/i,
            /(hitler|nazi).{0,20}(right|correct|good)/i,
            /(jews|jew|jewish).{0,20}(right|correct|good)/i,
            /(arab|arabs|muslims|islam).{0,20}(right|correct|good)/i,
            /(gas|burn|lynch).{0,20}(whites|browns|arabs|muslims|christians|straights|bisexuals|jews|blacks|gays|hindus)/i
          ],
          contextRules: {
            educationalContext: ['history', 'education', 'documentary', 'quoting'],
          }
        },
        
        // Targeted harassment
        harassment: {
          patterns: [
            /(kys|kill\s*yourself|end\s*yourself)/i,
            /(retard|retarded|autist|autistic).{0,20}(you|u\s*r|dumb)/i,
            /(ugly|fat|disgusting).{0,20}(bitch|whore|slut)/i,
            /(rope|neck|hang).{0,20}yourself/i,
            /no\s*one.{0,20}(likes|loves|wants).{0,20}you/i,
            /(worthless|useless|waste).{0,20}(life|space|person)/i
          ],
          contextRules: {
            targetRequired: true,
            multipleViolations: 2 // Requires 2+ patterns for medium severity
          }
        }
      },
      
      low: {
        // Spam patterns
        spam: {
          patterns: [
            /(click|visit|check\s*out).{0,20}(link|site|here)/i,
            /(earn|make).{0,20}\$\d+.{0,20}(day|hour|week)/i,
            /(viagra|cialis|pills).{0,20}(cheap|discount|sale)/i,
            /(crypto|bitcoin|nft).{0,20}(pump|moon|10x)/i,
            /(.)\1{10,}/, // Character spam
            /[A-Z\s]{20,}/, // CAPS spam
            /(\b\w{4,}\b)(?=.*?\1.*?\1.*?\1)/i, // A word of 4+ chars repeated at least 4 times
          ],
          contextRules: {
            urlDensity: 0.05, // More than 5% URLs
            repetitionThreshold: 5
          }
        }
      }
    };
    
    // Evasion technique patterns
    this.evasionPatterns = {
      leetspeak: {
        advanced: {
          'a': ['@', '4', 'Д', 'α', 'а', 'ą', 'ä', 'â', 'à', 'á', 'ª'],
          'e': ['3', '€', 'є', 'ε', 'е', 'ё', 'ę', 'ë', 'ê', 'è', 'é'],
          'i': ['1', '!', '|', 'і', 'ï', 'î', 'ì', 'í', 'ı'],
          'o': ['0', '()','[]', 'о', 'ø', 'ö', 'ô', 'ò', 'ó', 'º'],
          's': ['5', '$', 'z', 'ѕ', 'ş', 'ś', 'š'],
          't': ['7', '+', '†', 'т', 'ť', 'ţ'],
          'u': ['µ', 'ü', 'û', 'ù', 'ú', 'ū'],
          'c': ['(', '<', '©', 'ç', 'č', 'ć'],
          'n': ['И', 'π', 'ñ', 'ň', 'ń']
        }
      },
      
      spacing: {
        patterns: [
          /(\w)\s+(\w)/g, // Extra spaces
          /(\w)\.+(\w)/g, // Dot separation
          /(\w)_+(\w)/g,  // Underscore separation
          /(\w)-+(\w)/g,  // Dash separation
        ]
      },
      
      reversal: {
        check: async (text) => {
          const reversed = text.split('').reverse().join('');
          return await this.checkContent(reversed, { skipCache: true, skipReversal: true });
        }
      },
      
      zalgo: {
        pattern: /[\u0300-\u036f\u0483-\u0489\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g
      }
    };
    
    if (this.config?.customPatterns) {
     for (const [name, cfg] of Object.entries(this.config.customPatterns)) {
      const sev = (cfg.severity || 'medium').toLowerCase();
        if (!this.harmPatterns[sev]) this.harmPatterns[sev] = {};
       this.harmPatterns[sev][name] = {
         patterns: cfg.patterns || [],
         contextRules: cfg.contextRules || {},
        };
      }
    }
    
    
    // Contextual rules
    this.contextRules = {
      quotation: /["'`"""''‚„«»‹›「」『』【】〔〕〈〉《》]/,
      educational: /\b(study|research|paper|article|essay|report|teach|learn|history|education)\b/i,
      news: /\b(news|report|journalism|article|breaking|update|according\s*to)\b/i,
      fiction: /\b(story|novel|book|character|fiction|fantasy|movie|film|game)\b/i,
      support: /\b(help|support|hotline|crisis|therapy|counseling|prevention)\b/i
    };
    
    
  }
  
  initializeNormalizers() {
    // Unicode normalizations map
    this.unicodeMap = new Map();
    
    // Build comprehensive unicode normalization map
    const addMapping = (normalized, ...variants) => {
      variants.forEach(v => this.unicodeMap.set(v, normalized));
    };

    
    
    // Latin variants
    addMapping('a', 'à', 'á', 'â', 'ã', 'ä', 'å', 'ā', 'ă', 'ą', 'ǎ', 'ǟ', 'ǡ', 'ǻ', 'ȁ', 'ȃ', 'ȧ', 'ɐ', 'ɑ', 'ɒ', 'α', 'а');
    addMapping('b', 'ḃ', 'ḅ', 'ḇ', 'ƀ', 'ƃ', 'ɓ', 'β', 'в', 'ϐ', 'ᵇ', 'ᵝ', 'ᶀ');
    addMapping('c', 'ç', 'ć', 'ĉ', 'ċ', 'č', 'ƈ', 'ɔ', 'ↄ', 'с', 'ϲ', 'ᶜ');
    addMapping('d', 'ď', 'đ', 'ḋ', 'ḍ', 'ḏ', 'ḑ', 'ḓ', 'ɖ', 'ɗ', 'ᵈ', 'ᶁ', 'ᶑ', 'д');
    addMapping('e', 'è', 'é', 'ê', 'ë', 'ē', 'ĕ', 'ė', 'ę', 'ě', 'ǝ', 'ɘ', 'ɛ', 'ε', 'е', 'ё', 'э', 'є');
    addMapping('f', 'ḟ', 'ƒ', 'ᵮ', 'ᶂ', 'ᶠ', 'φ', 'ф');
    addMapping('g', 'ĝ', 'ğ', 'ġ', 'ģ', 'ǧ', 'ǵ', 'ɠ', 'ɡ', 'ᵍ', 'ᶃ', 'ᶢ', 'г', 'ґ');
    addMapping('h', 'ĥ', 'ħ', 'ḣ', 'ḥ', 'ḧ', 'ḩ', 'ḫ', 'ɦ', 'ɧ', 'ᴴ', 'ʰ', 'ᶣ', 'н');
    addMapping('i', 'ì', 'í', 'î', 'ï', 'ĩ', 'ī', 'ĭ', 'į', 'ı', 'ǐ', 'ɨ', 'ɩ', 'ɪ', 'ι', 'і', 'ї', 'y','ι'); 
    addMapping('j', 'ĵ', 'ǰ', 'ɉ', 'ʝ', 'ⱼ', 'ᶡ', 'ᶨ', 'й', 'ј');
    addMapping('k', 'ķ', 'ĸ', 'ǩ', 'ḱ', 'ḳ', 'ḵ', 'ƙ', 'ⱪ', 'ᵏ', 'ᶄ', 'κ', 'к');
    addMapping('l', 'ĺ', 'ļ', 'ľ', 'ŀ', 'ł', 'ḷ', 'ḹ', 'ḻ', 'ḽ', 'ℓ', 'ʟ', 'ˡ', 'ᴸ', 'ᶫ', 'л');
    addMapping('m', 'ḿ', 'ṁ', 'ṃ', 'ɱ', 'ᵐ', 'ᴹ', 'ᶬ', 'м', 'μ');
    addMapping('n', 'ñ', 'ń', 'ņ', 'ň', 'ŋ', 'ṅ', 'ṇ', 'ṉ', 'ṋ', 'ɲ', 'ɳ', 'ᴺ', 'ⁿ', 'ᶮ', 'ᶯ', 'ᶰ', 'н', 'η', 'ν');
    addMapping('o', 'ò', 'ó', 'ô', 'õ', 'ö', 'ø', 'ō', 'ŏ', 'ő', 'ǒ', 'ǫ', 'ǭ', 'ɵ', 'ο', 'о', 'ө', 'ᵒ', 'ᴼ', 'ᶱ','ο');
    addMapping('p', 'ṕ', 'ṗ', 'ƥ', 'ᵖ', 'ᴾ', 'ᵽ', 'ᶈ', 'π', 'п', 'ρ');
    addMapping('q', 'ɋ', 'ʠ', 'ᵠ', 'ᶐ', 'ԛ');
    addMapping('r', 'ŕ', 'ŗ', 'ř', 'ṙ', 'ṛ', 'ṝ', 'ṟ', 'ȑ', 'ȓ', 'ɍ', 'ɹ', 'ɻ', 'ʳ', 'ᴿ', 'ᵣ', 'ᶉ', 'г', 'я');
    addMapping('s', 'ś', 'ŝ', 'ş', 'š', 'ș', 'ṡ', 'ṣ', 'ṥ', 'ṧ', 'ṩ', 'ʂ', 'ˢ', 'ᔆ', 'ᵴ', 'ᶊ', 'ѕ', 'с');
    addMapping('t', 'ţ', 'ť', 'ŧ', 'ṫ', 'ṭ', 'ṯ', 'ṱ', 'ẗ', 'ƭ', 'ʈ', 'ᴛ', 'ᵗ', 'ᵀ', 'ᶵ', 'т', 'τ');
    addMapping('u', 'ù', 'ú', 'û', 'ü', 'ũ', 'ū', 'ŭ', 'ů', 'ű', 'ų', 'ǔ', 'ǖ', 'ǘ', 'ǚ', 'ǜ', 'ȕ', 'ȗ', 'ʉ', 'ᵘ', 'ᵤ', 'ᶶ', 'у', 'ц', 'μ');
    addMapping('v', 'ṽ', 'ṿ', 'ʋ', 'ᵛ', 'ᵥ', 'ᶹ', 'ν', 'в');
    addMapping('w', 'ŵ', 'ẁ', 'ẃ', 'ẅ', 'ẇ', 'ẉ', 'ẘ', 'ᴡ', 'ʷ', 'ᵂ', 'ᶭ', 'ω', 'ш', 'щ');
    addMapping('x', 'ẋ', 'ẍ', 'ᵡ', 'ᶍ', 'χ', 'х', '×');
    addMapping('y', 'ý', 'ÿ', 'ŷ', 'ȳ', 'ẏ', 'ẙ', 'ỳ', 'ỵ', 'ỷ', 'ỹ', 'ʸ', 'ᵞ', 'ᶌ', 'у', 'ү', 'ყ');
    addMapping('z', 'ź', 'ż', 'ž', 'ẑ', 'ẓ', 'ẕ', 'ƶ', 'ʐ', 'ʑ', 'ᴢ', 'ᵶ', 'ᶻ', 'з', 'ζ');
    
    // Number substitutions
    addMapping('0', 'О', 'о', 'Ο', 'ο', 'O', 'o', '०', '০', '੦', '૦', '୦', '௦', 'ం', '౦', '೦', 'ഠ', '൦', '๐', '໐', '၀', '༠');
    addMapping('1', 'I', 'l', '|', 'ı', 'ɪ', '¹', '₁', '१', '১', '੧', '૧', '୧', '௧', '౧', '೧', '൧', '๑', '໑', '၁', '༡');
    addMapping('2', 'ƻ', '²', '₂', '२', '২', '੨', '૨', '୨', '௨', '౨', '೨', '൨', '๒', '໒', '၂', '༢');
    addMapping('3', 'Ʒ', 'ʒ', 'З', 'з', '³', '₃', 'ℨ', 'ℤ', '३', '৩', '੩', '૩', '୩', '௩', '౩', '೩', '൩', '๓', '໓', '၃', '༣');
    addMapping('4', 'Ч', 'ч', '⁴', '₄', '४', '৪', '੪', '૪', '୪', '௪', '౪', '೪', '൪', '๔', '໔', '၄', '༤');
    addMapping('5', 'S', 's', '⁵', '₅', '५', '৫', '੫', '૫', '୫', '௫', '౫', '೫', '൫', '๕', '໕', '၅', '༥');
    addMapping('6', 'б', '⁶', '₆', '६', '৬', '੬', '૬', '୬', '௬', '౬', '೬', '൬', '๖', '໖', '၆', '༦');
    addMapping('7', '⁷', '₇', '७', '৭', '੭', '૭', '୭', '௭', '౭', '೭', '൭', '๗', '໗', '၇', '༧');
    addMapping('8', '⁸', '₈', '८', '৮', '੮', '૮', '୮', '௮', '౮', '೮', '൮', '๘', '໘', '၈', '༨');
    addMapping('9', '⁹', '₉', '९', '৯', '੯', '૯', '୯', '௯', '౯', '೯', '൯', '๙', '໙', '၉', '༩');

    //other
    addMapping('k', 'ķ', 'ĸ', 'ǩ', 'ḱ', 'ḳ', 'ḵ', 'ƙ', 'ⱪ', 'ᵏ', 'ᶄ', 'κ', 'к', 'ҡ', 'қ');
    addMapping('l', 'ĺ', 'ļ', 'ľ', 'ŀ', 'ł', 'ḷ', 'ḹ', 'ḻ', 'ḽ', 'ℓ', 'ʟ', 'ˡ', 'ᴸ', 'ᶫ', 'л', 'ӆ');
    addMapping('u', 'ù', 'ú', 'û', 'ü', 'ũ', 'ū', 'ŭ', 'ů', 'ű', 'ų', 'ǔ', 'ǖ', 'ǘ', 'ǚ', 'ǜ', 'ȕ', 'ȗ', 'ʉ', 'ᵘ', 'ᵤ', 'ᶶ', 'у', 'ц', 'μ', 'µ');
    addMapping('y', 'ý', 'ÿ', 'ŷ', 'ȳ', 'ẏ', 'ẙ', 'ỳ', 'ỵ', 'ỷ', 'ỹ', 'ʸ', 'ᵞ', 'ᶌ', 'у', 'ү', 'ყ', '¥');
    addMapping('o', 'ò', 'ó', 'ô', 'õ', 'ö', 'ø', 'ō', 'ŏ', 'ő', 'ǒ', 'ǫ', 'ǭ', 'ɵ', 'ο', 'о', 'ө', 'ᵒ', 'ᴼ', 'ᶱ', 'ø');

    // Build reverse mapping for efficiency
    this.reverseUnicodeMap = new Map();
    for (const [variant, normalized] of this.unicodeMap) {
      if (!this.reverseUnicodeMap.has(normalized)) {
        this.reverseUnicodeMap.set(normalized, []);
      }
      this.reverseUnicodeMap.get(normalized).push(variant);
    }
  }
  
compilePatterns() {
  console.log('[ContentSafety] Starting pattern compilation...');
  const compiled = new Map();

  // First, verify harmPatterns exists
  if (!this.harmPatterns) {
    console.error('[ContentSafety] ERROR: harmPatterns is undefined!');
    return compiled;
  }

  for (const [severity, categories] of Object.entries(this.harmPatterns)) {
    console.log(`[ContentSafety] Compiling severity: ${severity}`);
    compiled.set(severity, new Map());

    if (!categories || typeof categories !== 'object') {
      console.error(`[ContentSafety] Invalid categories for ${severity}:`, categories);
      continue;
    }

    for (const [category, config] of Object.entries(categories)) {
      console.log(`[ContentSafety]   Compiling category: ${category}`);
      if (!config) {
        console.error(`[ContentSafety] Config is undefined for ${severity}.${category}`);
        continue;
      }

      if (!config.patterns) {
        console.error(`[ContentSafety] No patterns array for ${severity}.${category}`);
        compiled.get(severity).set(category, {
          patterns: [],
          contextRules: config.contextRules || {}
        });
        continue;
      }

      if (!Array.isArray(config.patterns)) {
        console.error(`[ContentSafety] Patterns is not an array for ${severity}.${category}:`, config.patterns);
        continue;
      }

      const compiledPatterns = [];
      for (let i = 0; i < config.patterns.length; i++) {
        const pattern = config.patterns[i];
        if (!pattern) {
          console.error(`[ContentSafety] Pattern ${i} is undefined in ${severity}.${category}`);
          continue;
        }

        try {
          let newPattern;
          // Handle both RegExp objects from code and strings from JSON
          if (pattern instanceof RegExp) {
            // It's a hard-coded RegExp object, use it as-is
            newPattern = pattern;
          } else if (typeof pattern === 'string') {
            // It's a string from JSON, create a new RegExp from it
            // We assume case-insensitivity ('i') is a good default for all rules
            newPattern = new RegExp(pattern, 'i');
          } else {
            console.error(`[ContentSafety] Pattern ${i} is not a RegExp or a string in ${severity}.${category}:`, typeof pattern);
            continue;
          }
          compiledPatterns.push(newPattern);
        } catch (e) {
          console.error(`[ContentSafety] Failed to compile pattern ${i} in ${severity}.${category}:`, e, pattern);
        }
      }

      console.log(`[ContentSafety]   Compiled ${compiledPatterns.length} patterns for ${category}`);
      compiled.get(severity).set(category, {
        patterns: compiledPatterns,
        contextRules: config.contextRules || {}
      });
    }
  }

  console.log('[ContentSafety] Pattern compilation complete');
  console.log('[ContentSafety] Compiled structure:', compiled);

  return compiled;
}
  
  /**
   * Main content checking method
   */
  async checkContent(text, options = {}) {
    const startTime = performance.now();
    
    // Input validation
    if (!text || typeof text !== 'string') {
      return { safe: true, violations: [], checkTime: 0 };
    }
    
    // Length check
    if (text.length > this.config.maxTextLength) {
      return {
        safe: false,
        shouldBlock: true,
        violations: [{
          type: 'length_exceeded',
          severity: 'medium',
          confidence: 1.0
        }],
        checkTime: performance.now() - startTime
      };
    }
    
    if (!options.skipReversal && this.evasionPatterns.reversal.check) {
        const reversedResult = await this.evasionPatterns.reversal.check(text);
        if (reversedResult && reversedResult.shouldBlock) {
            return reversedResult;
        }
    }

    // Cache check
    const cacheKey = this.generateCacheKey(text);
    if (!options.skipCache && this.cache.has(cacheKey)) {
      this.cacheHits++;
      const cached = this.cache.get(cacheKey);
      return { ...cached, fromCache: true, checkTime: performance.now() - startTime };
    }
    this.cacheMisses++;
    
    // Perform the check
    const result = await this.performComprehensiveCheck(text, options);
    
    // Update cache
    this.updateCache(cacheKey, result);
    
    // Update metrics
    this.updateMetrics(result, performance.now() - startTime);
    
    return {
      ...result,
      checkTime: performance.now() - startTime
    };
  }
  evaluateContextLegitimacy(text, factors) {
    let score = 0;
    const lowerText = text.toLowerCase();
    
    // Check for actual news-like structure
    if (factors.includes('news')) {
        const newsIndicators = [
            /breaking\s+news\s*:/i,
            /\b(reuters|ap|cnn|bbc|fox\s*news)\b/i,
            /\b(reporter|journalist|correspondent)\b/i,
            /\b(police|authorities|officials)\s+(said|reported|confirmed)/i,
            /according\s+to\s+(police|officials|sources)/i
        ];
        
        const newsMatches = newsIndicators.filter(pattern => pattern.test(text)).length;
        score += newsMatches * 0.2;
        
        // Penalty for suspicious patterns
        if (/^(news|breaking\s*news):\s*i\s*(will|am\s*going\s*to)/i.test(lowerText)) {
            score -= 0.5; // Likely fake context
        }
    }
    
    // Check for actual educational content
    if (factors.includes('educational')) {
        const eduIndicators = [
            /\b(lesson|chapter|section|unit)\s*\d+/i,
            /\b(teacher|professor|instructor|course)\b/i,
            /\b(students?|classroom|curriculum)\b/i,
            /\b(historical|academic|scholarly)\b/i,
            /\b(exam|test|assignment|homework)\b/i
        ];
        
        const eduMatches = eduIndicators.filter(pattern => pattern.test(text)).length;
        score += eduMatches * 0.15;
        
        // Must have substantial educational context
        if (text.length < 100) {
            score -= 0.3; // Too short to be real educational content
        }
    }
    
    // Fiction check
    if (factors.includes('fiction')) {
        const fictionIndicators = [
            /\b(chapter|scene|act)\s*\d+/i,
            /\b(character|protagonist|antagonist)\b/i,
            /\b(novel|story|book|script|screenplay|plot)\b/i,
            /"[^"]+"\s*(said|asked|replied|shouted)/i,
            /\b(fiction|fantasy|sci-fi|thriller)\b/i
        ];
        
        const fictionMatches = fictionIndicators.filter(pattern => pattern.test(text)).length;
        score += fictionMatches * 0.2;
    }
    
    // Special handling for gaming context
    if (factors.includes('fiction') && lowerText.includes('game')) {
        // Gaming discussions should be more lenient
        const gameIndicators = [
            /\b(game|gaming|player|level|mission|quest|character)\b/i,
            /\b(call\s*of\s*duty|fortnite|minecraft|gta)\b/i,
            /\b(npc|pvp|fps|rpg|mmo)\b/i
        ];
        
        const gameMatches = gameIndicators.filter(pattern => pattern.test(text)).length;
        score += gameMatches * 0.3;
    }

    // For legitimate support context
    if (factors.includes('support') && factors.includes('selfharm')) {
        const supportIndicators = [
            /\b(hotline|crisis|prevention|help)\b/i,
            /\b(988|suicide\s*prevention)\b/i,
            /\b(available|support|counseling)\b/i,
            /\b(you\s*are\s*not\s*alone)\b/i
        ];
        
        const supportMatches = supportIndicators.filter(pattern => pattern.test(text)).length;
        if (supportMatches >= 3) {
            score = 0.9; // Very likely legitimate support content
        }
    }
    
    
    // Length check - real context usually has more content
    if (text.length > 200) {
        score += 0.1;
    }
    
    // Check for quotation marks (might be quoting)
    if ((text.match(/["'"]/g) || []).length >= 2) {
        score += 0.1;
    }
    
    return Math.max(0, Math.min(1, score));
}


async performComprehensiveCheck(text, options) {

  const violations = [];
  let contextAnalysis = null;

  // 1. Quick evasion check FIRST
  const quickEvasions = this.quickEvasionCheck(text);
  violations.push(...quickEvasions);
  
  // 2. Fuzzy matching check
  const fuzzyViolations = this.checkFuzzyHarmfulWords(text);
  violations.push(...fuzzyViolations);
  
  // 3. ADD THIS: N-gram similarity check
  const ngramViolations = this.checkNgramSimilarity(text);
  violations.push(...ngramViolations);

  // 4. Markov Chain sequence analysis
  const markovViolation = this.markovClassifier.analyze(text);
  if (markovViolation) {
    violations.push(markovViolation);
  }

  // 5. Detect obfuscation attempts (renumber from 3)
  const obfuscation = this.detectObfuscation(text);
  if (obfuscation.score > 0.3) {
    violations.push({
      type: 'obfuscation_attempt',
      severity: obfuscation.score > 0.5 ? 'high' : 'medium',
      confidence: obfuscation.score,
      techniques: obfuscation.techniques
    });
  }
  
  
  // If obfuscation is high, find the specific underlying threat
if (obfuscation.score > 0.5) {
  
  // Check against all critical patterns
  const threatPatterns = [
    { pattern: /kill\s*you/i, type: 'threats', severity: 'high' },
    { pattern: /murder/i, type: 'threats', severity: 'high' },
    { pattern: /bomb/i, type: 'terrorism', severity: 'critical' },
    { pattern: /suicide/i, type: 'selfharm', severity: 'high' }
  ];
  
  for (const { pattern, type, severity } of threatPatterns) {
    if (pattern.test(text)) {
      violations.push({
        type,
        severity,
        confidence: 0.8,
        method: 'obfuscation_underlying',
        match: text.match(pattern)[0]
      });
      break;
    }
  }

  // If we found a specific threat, remove the generic obfuscation violation
  if (violations.some(v => v.method === 'obfuscation_underlying')) {
    const index = violations.findIndex(v => v.type === 'obfuscation_attempt');
    if (index !== -1) violations.splice(index, 1);
  }
}
  // 6. Normalize text through multiple passes
  const normalizations = this.getNormalizedVariants(text);
  
  // 7. Check each normalization
  for (const normalized of normalizations) {
    // FIXED: Do not check patterns on aggressively normalized text that comes from css-like content
    if (normalized.method === 'aggressive' && text.includes(':') && text.includes(';')) {
        continue;
    }
    const patternViolations = this.checkPatterns(normalized.text, text, normalized.method);
    violations.push(...patternViolations);
  }
  
  // 8. Context analysis (MODIFIED)
  // We now only gather the context factors here. The mitigation logic is moved to calculateVerdict.
  contextAnalysis = this.analyzeContext(text, violations);
  violations.push(...contextAnalysis.additionalViolations);

  // 9. Behavioral analysis
  const behavioral = this.analyzeBehavior(text, violations);
  violations.push(...behavioral);

  // --- Machine Learning Check ---
  // The NBC now acts as just another rule in the system.
  const nbcResult = this.classifier.predict(text);
  if (nbcResult.label === 'not_safe' && nbcResult.probability > this.config.nbcBlockThreshold) {
    violations.push({
      type: 'ml_flagged',
      severity: 'medium',
      confidence: nbcResult.probability,
      method: 'nbc'
    });
  }

  const uniqueViolations = this.deduplicateViolations(violations);
  // Pass all necessary info to the new calculateVerdict function
  const finalVerdict = this.calculateVerdict(uniqueViolations, contextAnalysis, text, nbcResult);

    return {
      safe: finalVerdict.safe,
      violations: uniqueViolations,
      shouldBlock: finalVerdict.shouldBlock,
      confidence: finalVerdict.confidence,
      metadata: {
        nbcScore: nbcResult.label === 'not_safe' ? nbcResult.probability : 1 - nbcResult.probability,
        nbcLabel: nbcResult.label
      }
    };
  }


checkNgramSimilarity(text) {
  const violations = [];
  const processText = text.slice(0, 500);

  if (processText.length < 3) return violations;

  const generateTrigrams = (str) => {
    const trigrams = new Set();
    
    // 1. Sanitize: Replace all non-alphanumeric characters (except spaces) 
    // with a space, then collapse multiple spaces to one.
    const sanitizedStr = str.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ');

    // 2. Split the sanitized string into words.
    const words = sanitizedStr.split(' ');

    // 3. Iterate over each word to generate its trigrams.
    for (const word of words) {
      if (word.length < 3) continue;

      for (let i = 0; i <= word.length - 3; i++) {
        trigrams.add(word.slice(i, i + 3));
      }
    }
    return trigrams;
  };

  const harmfulSignatures = {
    'bom': { word: 'bomb', type: 'terrorism', severity: 'critical' },
    'omb': { word: 'bomb', type: 'terrorism', severity: 'critical' },
    'exp': { word: 'explosive', type: 'terrorism', severity: 'critical' },
    'plo': { word: 'explosive', type: 'terrorism', severity: 'critical' },
    'det': { word: 'detonate', type: 'terrorism', severity: 'critical' },
    'ton': { word: 'detonate', type: 'terrorism', severity: 'critical' },
    'ric': { word: 'ricin', type: 'terrorism', severity: 'critical' },
    'sar': { word: 'sarin', type: 'terrorism', severity: 'critical' },
    'thr': { word: 'anthrax', type: 'terrorism', severity: 'critical' },
    'kil': { word: 'kill', type: 'threats', severity: 'high', context: ['you', 'them', 'all', 'me'] }, 
    'ill': { word: 'kill', type: 'threats', severity: 'high' },
    'mur': { word: 'murder', type: 'threats', severity: 'high' },
    'urd': { word: 'murder', type: 'threats', severity: 'high' },
    'der': { word: 'murder', type: 'threats', severity: 'high' },
    'sho': { word: 'shoot', type: 'threats', severity: 'high' },
    'oot': { word: 'shoot', type: 'threats', severity: 'high' },
    'sta': { word: 'stab', type: 'threats', severity: 'high' },
    'tab': { word: 'stab', type: 'threats', severity: 'high' },
    'str': { word: 'strangle', type: 'threats', severity: 'high' },
    'ang': { word: 'strangle', type: 'threats', severity: 'high' },
    'rap': { word: 'rape', type: 'threats', severity: 'high' },
    'ape': { word: 'rape', type: 'threats', severity: 'high' },
    'sui': { word: 'suicide', type: 'selfharm', severity: 'high' },
    'uic': { word: 'suicide', type: 'selfharm', severity: 'high' },
    'ici': { word: 'suicide', type: 'selfharm', severity: 'high' },
    'cid': { word: 'suicide', type: 'selfharm', severity: 'high' },
    'ide': { word: 'suicide', type: 'selfharm', severity: 'high' },
    'ove': { word: 'overdose', type: 'selfharm', severity: 'high' },
    'ver': { word: 'overdose', type: 'selfharm', severity: 'high' },
    'dos': { word: 'overdose', type: 'selfharm', severity: 'high' },
    'mol': { word: 'molest', type: 'csam', severity: 'critical' },
    'les': { word: 'molest', type: 'csam', severity: 'critical' },
    'ped': { word: 'pedo', type: 'csam', severity: 'critical' },
    'edo': { word: 'pedo', type: 'csam', severity: 'critical' },
    'lol': { word: 'loli', type: 'csam', severity: 'critical' },
    'oli': { word: 'loli', type: 'csam', severity: 'critical' },
    'csa': { word: 'csam', type: 'csam', severity: 'critical' },
    'sam': { word: 'csam', type: 'csam', severity: 'critical' },
    'coc': { word: 'cocaine', type: 'illegal_trade', severity: 'high' },
    'oca': { word: 'cocaine', type: 'illegal_trade', severity: 'high' },
    'ain': { word: 'cocaine', type: 'illegal_trade', severity: 'high' },
    'her': { word: 'heroin', type: 'illegal_trade', severity: 'high' },
    'ero': { word: 'heroin', type: 'illegal_trade', severity: 'high' },
    'fen': { word: 'fentanyl', type: 'illegal_trade', severity: 'high' },
    'ent': { word: 'fentanyl', type: 'illegal_trade', severity: 'high' },
    'nyl': { word: 'fentanyl', type: 'illegal_trade', severity: 'high' },
    'met': { word: 'meth', type: 'illegal_trade', severity: 'high' },
    'eth': { word: 'meth', type: 'illegal_trade', severity: 'high' },
    'dox': { word: 'doxx', type: 'doxxing', severity: 'high' },
    'oxx': { word: 'doxx', type: 'doxxing', severity: 'high' },
    'swa': { word: 'swat', type: 'doxxing', severity: 'critical' },
    'wat': { word: 'swat', type: 'doxxing', severity: 'critical' },
    'add': { word: 'address', type: 'doxxing', severity: 'high' },
    'ddr': { word: 'address', type: 'doxxing', severity: 'high' },
    'res': { word: 'address', type: 'doxxing', severity: 'high' }
  };
  
  const textTrigrams = generateTrigrams(processText);
  const wordMatches = new Map();
  
  for (const trigram of textTrigrams) {
    if (harmfulSignatures[trigram]) {
      const config = harmfulSignatures[trigram];
      // Context check for sensitive trigrams
      if (config.context) {
          const hasContext = config.context.some(ctx => text.toLowerCase().includes(ctx));
          if (!hasContext) continue; // Skip if required context is missing
      }
      const currentCount = wordMatches.get(config.word) || 0;
      wordMatches.set(config.word, currentCount + 1);
    }
  }
  
    for (const [word, count] of wordMatches) {
        if (count >= 3) { // Change from 2 to 3
            const config = Object.values(harmfulSignatures).find(h => h.word === word);
            
            // Also check if it's in a metaphorical context
            const metaphoricalContext = /\b(headache|joke|burger|coffee|presentation)\b/i.test(text);
            if (metaphoricalContext && ['kill', 'murder', 'bomb'].includes(word)) {
                continue; // Skip if metaphorical
            }
            
            violations.push({
                type: config.type,
                severity: config.severity,
                confidence: Math.min(count * 0.1, 0.8),
                method: 'ngram_analysis',
                match: word
            });
        }
    }
  
  return violations;
}

  detectObfuscation(text) {
    const techniques = [];
    let score = 0;
    
    // Character substitution detection
    const substitutionRatio = this.calculateSubstitutionRatio(text);
    if (substitutionRatio > 0.3) {
      techniques.push('character_substitution');
      score += substitutionRatio * 0.5;
    }
    
    // Spacing anomalies
    const spacingScore = this.detectSpacingAnomalies(text);
    if (spacingScore > 0.5) {
      techniques.push('spacing_manipulation');
      score += spacingScore * 0.2;
    }
    
    // Mixed script detection
    const scriptMixing = this.detectMixedScripts(text);
    if (scriptMixing.mixed) {
      techniques.push('mixed_scripts');
      score += 0.3;
    }
    
    // Zalgo text
    if (this.evasionPatterns.zalgo.pattern.test(text)) {
      techniques.push('zalgo_text');
      score += 0.4;
    }
    
    // Repetition patterns
    const repetitionScore = this.detectRepetition(text);
    if (repetitionScore > 0.5) {
      techniques.push('character_repetition');
      score += repetitionScore * 0.2;
    }
    
    // Case manipulation
    const caseScore = this.detectCaseManipulation(text);
    if (caseScore > 0.6) {
      techniques.push('case_manipulation');
      score += caseScore * 0.1;
    }
    
    return {
      score: Math.min(score, 1.0),
      techniques
    };
  }
  
  calculateSubstitutionRatio(text) {
    let substitutions = 0;
    const chars = text.split('');
    
    for (const char of chars) {
      if (this.unicodeMap.has(char)) {
        substitutions++;
      }
      // Check for leetspeak
      for (const [letter, variants] of Object.entries(this.evasionPatterns.leetspeak.advanced)) {
        if (variants.includes(char)) {
          substitutions++;
          break;
        }
      }
    }
    
    return substitutions / chars.length;
  }
  
  detectSpacingAnomalies(text) {
    let anomalies = 0;
    
    // Extra spaces between letters
    const extraSpaces = (text.match(/\w\s{2,}\w/g) || []).length;
    anomalies += extraSpaces * 0.2;
    
    // Dots, underscores, or dashes between letters
    const separators = (text.match(/\w[._-]+\w/g) || []).length;
    anomalies += separators * 0.3;
    
    // Zero-width characters
    const zeroWidth = (text.match(/[\u200b\u200c\u200d\ufeff]/g) || []).length;
    anomalies += zeroWidth * 0.5;
    
    return Math.min(anomalies / text.length * 10, 1.0);
  }
  
  detectMixedScripts(text) {
    const scripts = new Set();
    const scriptRanges = [
      { name: 'latin', regex: /[a-zA-Z]/ },
      { name: 'cyrillic', regex: /[\u0400-\u04FF]/ },
      { name: 'greek', regex: /[\u0370-\u03FF]/ },
      { name: 'arabic', regex: /[\u0600-\u06FF]/ },
      { name: 'hebrew', regex: /[\u0590-\u05FF]/ },
      { name: 'chinese', regex: /[\u4E00-\u9FFF]/ },
      { name: 'japanese', regex: /[\u3040-\u309F\u30A0-\u30FF]/ },
      { name: 'korean', regex: /[\uAC00-\uD7AF]/ }
    ];
    
    for (const char of text) {
      for (const script of scriptRanges) {
        if (script.regex.test(char)) {
          scripts.add(script.name);
        }
      }
    }
    
    return {
      mixed: scripts.size > 1,
      scripts: Array.from(scripts)
    };
  }
  
  detectRepetition(text) {
    // Character repetition
    const charRepeat = Math.max(...(text.match(/(.)\1{2,}/g) || []).map(m => m.length)) || 0;
    
    // Word repetition
    const words = text.toLowerCase().split(/\s+/);
    const wordCounts = {};
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
    const maxWordRepeat = Math.max(...Object.values(wordCounts));
    
    return Math.min((charRepeat / 10 + maxWordRepeat / words.length) / 2, 1.0);
  }
  
  detectCaseManipulation(text) {
    const upperCount = (text.match(/[A-Z]/g) || []).length;
    const lowerCount = (text.match(/[a-z]/g) || []).length;
    const totalLetters = upperCount + lowerCount;
    
    if (totalLetters === 0) return 0;
    
    // Alternating case detection
    const alternating = (text.match(/[a-z][A-Z]|[A-Z][a-z]/g) || []).length;
    const alternatingRatio = alternating / Math.max(totalLetters - 1, 1);
    
    // Random case detection
    const upperRatio = upperCount / totalLetters;
    const randomCase = upperRatio > 0.3 && upperRatio < 0.7;
    
    return Math.max(alternatingRatio, randomCase ? 0.7 : 0);
  }
  
  getNormalizedVariants(text) {
    const variants = [];
    
      // Ensure text is a string
  if (!text || typeof text !== 'string') {
    return [{ text: '', method: 'original' }];
  }
  
    
    // Original text
    variants.push({ text: text, method: 'original' });
    
    // Basic normalization
    variants.push({ 
      text: this.basicNormalize(text), 
      method: 'basic' 
    });
    
    // Unicode normalization
    variants.push({ 
      text: this.unicodeNormalize(text), 
      method: 'unicode' 
    });
    
    // Aggressive normalization
    variants.push({ 
      text: this.aggressiveNormalize(text), 
      method: 'aggressive' 
    });
    
    // Remove all spaces
    variants.push({ 
      text: text.replace(/\s+/g, ''), 
      method: 'no_spaces' 
    });
    
    // Phonetic normalization
    variants.push({ 
      text: this.phoneticNormalize(text), 
      method: 'phonetic' 
    });
    
    return variants;
  }
  
basicNormalize(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
  
  
  unicodeNormalize(text) {
    if (!text || typeof text !== 'string') return '';

    // FIXED: If the text looks like CSS, don't strip essential characters.
    if (text.includes(':') && text.includes(';')) {
        return text.toLowerCase().replace(/\s+/g, ' ');
    }

    let normalized = '';

    // 1. Iterate character by character and replace using the map.
    for (const char of text) {
      normalized += this.unicodeMap.get(char.toLowerCase()) || char;
    }

    // 2. Convert to a consistent case.
    normalized = normalized.toLowerCase();

    // 3. Apply basic leetspeak for any remaining numbers/symbols.
    normalized = normalized
      .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
      .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
      .replace(/8/g, 'b').replace(/@/g, 'a').replace(/\$/g, 's')
      .replace(/!/g, 'i');

    // 4. Remove Zalgo text.
    normalized = normalized.replace(this.evasionPatterns.zalgo.pattern, '');

    // 5. Perform standard Unicode form normalization.
    normalized = normalized.normalize('NFKD');

    // 6. Clean up any remaining non-word characters and extra spaces.
    normalized = normalized.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    return normalized;
}
  
  
    
    
  quickEvasionCheck(text) {
      const violations = [];
      
      // Common evasion patterns that should trigger immediate flags
      const evasionPhrases = [
        { pattern: /b[0o]m[b8](?!\s*(test|exam|joke|comedy))/i, type: 'terrorism', severity: 'critical' },
        // FIXED: Make the "kill" check more specific to avoid names
        { pattern: /\bk[i1!]+ll\s*(you|them|him|her|myself)\b/i, type: 'threats', severity: 'high' },
        { pattern: /k[i1!]ll\s*y[o0]u/i, type: 'threats', severity: 'high' },
        { pattern: /su[i1!]c[i1!]d[e3]/i, type: 'selfharm', severity: 'high' },
        { pattern: /[ck]ill[sz]?\s*[ck]ids?/i, type: 'threats', severity: 'critical' },
        { pattern: /\b\d{1,2}\s*y[o0]\b/i, type: 'csam', severity: 'critical' },
        { pattern: /[e3]xpl[o0]s[i1]v[e3]/i, type: 'terrorism', severity: 'critical' },
        { pattern: /d[e3]t[o0]n[a4]t[e3]/i, type: 'terrorism', severity: 'critical' },
        
        // More threat variations
        { pattern: /m[u\|_]rd[e3]r/i, type: 'threats', severity: 'high' },
        { pattern: /sh[o0][o0]t/i, type: 'threats', severity: 'high' },
        { pattern: /st[a4]b/i, type: 'threats', severity: 'high' },
        { pattern: /r[a4]p[e3]/i, type: 'threats', severity: 'high' },
        
        // Drug variations
        { pattern: /c[o0]c[a4][i1]n[e3]/i, type: 'illegal_trade', severity: 'high' },
        { pattern: /h[e3]r[o0][i1]n/i, type: 'illegal_trade', severity: 'high' },
        { pattern: /m[e3]th/i, type: 'illegal_trade', severity: 'high' },
        
        // CSAM variations
        { pattern: /p[e3]d[o0]/i, type: 'csam', severity: 'critical' },
        { pattern: /l[o0]l[i1]/i, type: 'csam', severity: 'critical' },
        { pattern: /ch[i1]ld.{0,10}p[o0]rn/i, type: 'csam', severity: 'critical' },
        
        // Doxxing
        { pattern: /d[o0]xx/i, type: 'doxxing', severity: 'high' },
        { pattern: /sw[a4]t/i, type: 'doxxing', severity: 'critical' }
      ];
      
      for (const { pattern, type, severity } of evasionPhrases) {
        if (pattern.test(text)) {
          violations.push({
            type,
            severity,
            confidence: 0.2,
            method: 'quick_evasion',
            match: text.match(pattern)[0]
          });
        }
      }
      
      return violations;
    }
  aggressiveNormalize(text) {
        if (!text || typeof text !== 'string') return '';

    // FIXED: If the text looks like CSS, don't be aggressive.
    if (text.includes(':') && text.includes(';')) {
        return this.unicodeNormalize(text);
    }

    let normalized = this.unicodeNormalize(text);
    
    // Remove all non-alphanumeric except spaces
    normalized = normalized.replace(/[^a-z0-9\s]/g, '');
    
    // Collapse repeated characters
    normalized = normalized.replace(/(.)\1+/g, '$1');
    
    // Remove single characters between words
    normalized = normalized.replace(/\b\w\b/g, '');
    
    return normalized.trim();
  }
  
  phoneticNormalize(text) {
        if (!text || typeof text !== 'string') return '';

    let normalized = this.basicNormalize(text);
    
    // Common phonetic substitutions
    const phonetic = {
      'kh': 'k',
      'yoo': 'you',
      'ph': 'f',
      'ck': 'k',
      'kn': 'n',
      'wr': 'r',
      'qu': 'kw',
      'x': 'ks',
      'tion': 'shun',
      'sion': 'shun',
      'ough': 'o',
      'augh': 'af',
      'eigh': 'ay'
    };
    
    for (const [find, replace] of Object.entries(phonetic)) {
      normalized = normalized.replace(new RegExp(find, 'g'), replace);
    }
    
    return normalized;
  }
  
checkPatterns(normalizedText, originalText, normalizationMethod) {
  const violations = [];
  
  if (!normalizedText || typeof normalizedText !== 'string') {
    return violations;
  }
  
  if (!this.compiledPatterns || this.compiledPatterns.size === 0) {
    return violations;
  }
  
  const paddedText = ` ${normalizedText} `;
  
  if (originalText && typeof originalText === 'string') {
    const asciiText = this.unicodeNormalize(originalText);
    if (asciiText !== originalText) {
      const threatConfig = this.compiledPatterns.get('high')?.get('threats');
      if (threatConfig && threatConfig.patterns) {
        for (const pattern of threatConfig.patterns) {
          if (pattern && pattern.test && pattern.test(asciiText)) {
            return [{
              type: 'threats',
              severity: 'high',
              pattern: pattern.source,
              normalizationMethod: 'unicode',
              confidence: 0.9
            }];
          }
        }
      }
    }
  }

  const legitimateContext = this.checkLegitimateContext(originalText);
  
  for (const [severity, categories] of this.compiledPatterns) {
    
    if (!categories || !(categories instanceof Map)) {
      continue;
    }
    
    for (const [category, config] of categories) {
      
      if (!config || !config.patterns || !Array.isArray(config.patterns)) {
        continue;
      }
      
      for (let i = 0; i < config.patterns.length; i++) {
        const pattern = config.patterns[i];
        
        if (!pattern || typeof pattern.test !== 'function') {
          continue;
        }
        
        let patternToTest = pattern;
        
        if (normalizationMethod !== 'original') {
          if (pattern.source === undefined) {
            continue;
          }
          
          try {
            const newSource = pattern.source.replace(/\\b/g, '');
            if (newSource !== pattern.source) {
              patternToTest = new RegExp(newSource, pattern.flags || '');
            }
          } catch (e) {
            continue;
          }
        }

        const matches = normalizedText.match(patternToTest) || paddedText.match(patternToTest);
        
        if (matches) {

            // Check for fake educational disclaimer FIRST
            const educationalBypass = /educational\s*purposes?\s*only/i;
            const instructionsPattern = /instructions?\s*(for|on|to)\s*(making|creating|building)/i;
            
            if (educationalBypass.test(originalText) && 
                instructionsPattern.test(originalText) &&
                ['terrorism', 'illegal_trade', 'csam'].includes(category)) {
                
                // This is a bypass attempt - force high severity
                violations.push({
                    type: category,
                    severity: 'critical',
                    confidence: 0.95,
                    pattern: pattern.source,
                    match: matches[0],
                    normalizationMethod: normalizationMethod,
                    note: 'educational disclaimer bypass attempt'
                });
                continue;
            }
            

            
            
          // ENHANCED: Check for false positive keywords first
          if (config.contextRules?.falsePositiveKeywords) {
            const hasFalsePositive = config.contextRules.falsePositiveKeywords.some(
              keyword => originalText.toLowerCase().includes(keyword)
            );
            if (hasFalsePositive) {
              continue; // Skip this violation
            }
          }
          
          // Existing context checking...
          if (config.contextRules) {
            if (config.contextRules.requiresContext) {
              const hasCtx = this.checkRequiredContext(originalText, config.contextRules);
              if (!hasCtx) continue;
            }
            
            // ENHANCED: More aggressive exception checking for creative content
            if (config.contextRules.exceptions) {
              if (legitimateContext.isLegitimate && 
                  config.contextRules.exceptions.includes(legitimateContext.type)) {
                continue; // Skip this violation entirely
              }
              
              // Also check for any exception keywords
              const hasException = config.contextRules.exceptions.some(
                ex => originalText.toLowerCase().includes(ex)
              );
              if (hasException) continue;
            }
          }
          
          violations.push({
            type: category,
            severity: severity,
            confidence: this.calculateConfidence(matches, normalizedText, normalizationMethod),
            pattern: pattern.source,
            match: matches[0],
            normalizationMethod: normalizationMethod
          });
          
          break; 
        }
      }
    }
  }
  
  return violations;
}

// Add new method to check legitimate contexts more thoroughly
checkLegitimateContext(text) {
  const context = {
    isLegitimate: false,
    type: null,
    confidence: 0
  };
  
  if (!text) return context;

  // News context - check for real news structure
  if (this.isLegitimateNewsContext(text)) {
    context.isLegitimate = true;
    context.type = 'news';
    context.confidence = 0.9;
  }
  // Educational context - check for real educational content
  else if (this.isLegitimateEducationalContext(text)) {
    context.isLegitimate = true;
    context.type = 'educational';
    context.confidence = 0.9;
  }
  // Fiction/gaming context
  else if (this.isLegitimateCreativeContext(text)) {
    context.isLegitimate = true;
    context.type = 'creative';
    context.confidence = 0.9;
  }
  // Support/crisis context
  else if (this.isLegitimateSupportContext(text)) {
    context.isLegitimate = true;
    context.type = 'support';
    context.confidence = 0.95;
  }
  
  return context;
}

// Add specific context validators
isLegitimateNewsContext(text) {
  const indicators = 0;
  
  // Must have substantial content (not just "news: threat")
  if (text.length < 100) return false;
  
  // Check for multiple news indicators
  const newsPatterns = [
    /\b(reuters|ap|cnn|bbc|fox\s*news|npr|guardian|times|post)\b/i,
    /\b(reporter|journalist|correspondent|editor)\b/i,
    /\b(police|authorities|officials|spokesperson)\s+(said|reported|confirmed|announced)/i,
    /according\s+to\s+(police|officials|sources|reports)/i,
    /\b(arrested|detained|charged|convicted|sentenced)\b/i,
    /\b(investigation|incident|event)\s+(occurred|happened|took\s+place)/i
  ];
  
  let matches = 0;
  for (const pattern of newsPatterns) {
    if (pattern.test(text)) matches++;
  }
  
  return matches >= 2;
}

isLegitimateEducationalContext(text) {
  if (text.length < 100) return false;
  
  const eduPatterns = [
    /\b(chapter|lesson|section|unit|module)\s*\d+/i,
    /\b(textbook|curriculum|syllabus|course\s*material)/i,
    /\b(professor|teacher|instructor|educator)\b/i,
    /\b(students?|classroom|lecture|academic)/i,
    /\b(exam|test|quiz|assignment|homework)/i,
    /\b(learn(?:ing)?|teach(?:ing)?|educat(?:e|ion)|study(?:ing)?)\b/i
  ];
  
  let matches = 0;
  for (const pattern of eduPatterns) {
    if (pattern.test(text)) matches++;
  }
  
  return matches >= 2;
}

isLegitimateCreativeContext(text) {
  const creativePatterns = [
    /\b(movie|film|show|series|documentary)\b/i, // Added more variants
    /\b(character|protagonist|antagonist|hero|villain|actor)\b/i,
    /\b(novel|story|book|script|screenplay|plot|scene)\b/i,
    /\b(game|gaming|player|npc|quest|mission|level)\b/i,
    /"[^"]+"\s*(said|asked|replied|shouted|whispered)/i,
    /\b(fiction|fantasy|sci-fi|thriller|drama|action)\b/i,
    /\b(in\s+the\s+(new|upcoming|latest|recent)\s+(movie|film|show|game))\b/i // Added this specific pattern
  ];
  
  let matches = 0;
  for (const pattern of creativePatterns) {
    if (pattern.test(text)) matches++;
  }
  
  // Lower threshold for obvious movie/game mentions
  if (/\b(movie|film|game|show)\b/i.test(text)) {
    return matches >= 1 && text.length > 20; // Reduced from 50
  }
  
  return matches >= 2 && text.length > 50;
}

isLegitimateSupportContext(text) {
  const supportPatterns = [
    /\b(suicide\s*prevention|crisis\s*intervention)\b/i,
    /\b(hotline|helpline|support\s*line)\b/i,
    /\b(988|1-?800-?273-?8255)\b/, // Suicide prevention numbers
    /\b(help\s*is\s*available|support\s*is\s*here|you\s*are\s*not\s*alone)\b/i,
    /\b(counseling|therapy|mental\s*health\s*support)\b/i,
    /\b(please\s*call|reach\s*out|get\s*help|seek\s*support)\b/i,
    /\b(thoughts\s*of\s*suicide)\b/i 
  ];
  
  let matches = 0;
  for (const pattern of supportPatterns) {
    if (pattern.test(text)) matches++;
  }
  
  return matches >= 2;
}

shouldSkipInContext(category, context, text) {
  // NEVER skip critical threats even in fiction
  if (this.harmPatterns.critical[category] || this.harmPatterns.high[category]) {
      // For threats in fiction, check if it's a direct threat
      if (category === 'threats' && context.type === 'creative') {
          // Look for first-person threats even in fiction
          const firstPersonThreat = /\b(i\s*(will|am\s*going\s*to)|gonna)\s*\w*\s*(kill|murder|hurt|shoot)\b/i;
          if (firstPersonThreat.test(text)) {
              return false; // Don't skip - this is still a threat
          }
      }
      return false;
  }


  const contextExemptions = {
    news: ['terrorism', 'hate_speech', 'threats', 'illegal_trade'],
    educational: ['terrorism', 'hate_speech', 'illegal_trade'],
    creative: ['threats', 'illegal_trade'],
    support: ['selfharm'] 
  };
  
  if (context.type === 'creative' && category === 'threats') {
    const gameViolencePattern = /\b(game|gaming|player|character|enemy|mission)\b/i;
    if (gameViolencePattern.test(text)) {
      return true;
    }
  }
  
  return contextExemptions[context.type]?.includes(category) && context.confidence > 0.6;
}
  
  checkRequiredContext(text, contextRules) {
    if (contextRules.mustInclude) {
      return contextRules.mustInclude.some(word => 
        text.toLowerCase().includes(word)
      );
    }
    return true;
  }
  
  calculateConfidence(matches, text, normalizationMethod) {
    let confidence = 0.8;
    
    // Exact match in original text gets higher confidence
    if (normalizationMethod === 'original') {
      confidence = 1.0;
    }
    
    // Adjust based on match quality
    const matchLength = matches[0].length;
    const textLength = text.length;
    const coverage = matchLength / textLength;
    
    confidence *= (0.5 + coverage * 0.5);
    
    return Math.min(confidence, 1.0);
  }
  
analyzeContext(text, violations) {
    const analysis = {
        mitigatingFactors: [],
        additionalViolations: []
    };
    
    if (!text) return analysis;

    // comprehensive metaphorical/idiomatic patterns
    const metaphoricalPatterns = [
        // Performance/success metaphors
        /\b(kill|killing|murder|slay|destroy)\s*(this|that|it|the)\s*(presentation|meeting|interview|exam|test|competition|game|performance)/i,
        /\b(nail|crush|ace|bomb)\s*(the|this|that)\s*(presentation|meeting|interview|exam|test)/i,
        
        // Physical discomfort metaphors
        /\b(headache|pain|heat|cold|weather|sun|humidity)\s*(is\s*)?(killing|murdering)\s*me/i,
        /\bis\s*(killing|murdering)\s*me\b/i,
        
        // Food/drink metaphors
        /\b(kill|murder|destroy)\s*(for|a)\s*(coffee|drink|burger|pizza|food|meal|snack|beer|chocolate)/i,
        /\b(could\s*)?(kill|murder)\s*(for|a)\s*(some|a)\s*\w+/i,
        /\bliterally\s*(kill|die|murder)\s*for/i,
        
        // Parental/authority figure metaphors
        /\b(mom|dad|parent|boss|teacher|wife|husband|partner)\s*(will|is\s*gonna|going\s*to)\s*(kill|murder)\s*me/i,
        
        // Comedy/entertainment metaphors
        /\bdie\s*(laughing|of\s*laughter|from\s*laughter)/i,
        /\b(joke|comedy|comedian|comic|routine|act|show)\s*(bombed|killed|died|murdered)/i,
        /\b(bombed|killed)\s*(the\s*)?(audience|crowd|room)/i,
        /\bkilled\s*it\b/i,
        
        // Mechanical/technical metaphors
        /\bkill\s*(the\s*)?(lights|music|sound|engine|motor|power|switch)/i,
        
        // General success/failure metaphors
        /\b(absolutely|totally|completely)?\s*(killed|murdered|destroyed|bombed)\s*it/i,
        /\bgonna\s*(kill|murder|destroy)\s*this/i,
        
        // Hunger metaphors
        /\bso\s*hungry\s*i\s*could\s*(kill|murder|die)/i,
        /\bi['']?ll\s*(kill|murder)\s*for\s*(some|a)/i
    ];
    
    for (const pattern of metaphoricalPatterns) {
        if (pattern.test(text)) {
            analysis.mitigatingFactors.push('metaphorical');
            analysis.mitigatingFactors.push('idiomatic');
            break;
        }
    }
    // IMMEDIATE movie/creative detection
    if (/\b(movie|film|show|series|character|scene|actor|plot|story)\b/i.test(text)) {
        analysis.mitigatingFactors.push('creative');
        analysis.mitigatingFactors.push('fiction');
        analysis.mitigatingFactors.push('movie'); // Add specific movie factor
    }
    // Require substantial context, not just a keyword
    const words = text.split(/\s+/).length;
    
    // Check for quotations with minimum content
    if (this.contextRules.quotation.test(text) && words > 10) {
        analysis.mitigatingFactors.push('quotation');
    }
    if (this.contextRules.quotation.test(text)) {
  // Check if it's a properly attributed quote
  const attributedQuote = /\b(said|wrote|stated|according to|quoted)\b[^"]*"[^"]+"/i;
  const movieGameQuote = /\b(movie|film|book|game|show|character)\b[^"]*"[^"]+"/i;
  
  if (attributedQuote.test(text) || movieGameQuote.test(text)) {
    analysis.mitigatingFactors.push('attributed_quote');
    
    // Downgrade severity for quoted content
    for (const violation of violations) {
      if (violation.severity !== 'critical') { // Never downgrade critical
        violation.contextMitigation = true;
        violation.mitigationConfidence = 0.8;
      }
    }
  }
}
    // Educational context needs more than just the word "education"
    if (this.contextRules.educational.test(text) && words > 20) {
        const eduWords = text.match(/\b(study|research|paper|article|essay|report|teach|learn|history|education)\b/gi) || [];
        if (eduWords.length >= 2) { // Require multiple educational words
            analysis.mitigatingFactors.push('educational');
        }
    }
    
    // Check for quotations
    if (this.contextRules.quotation.test(text)) {
      analysis.mitigatingFactors.push('quotation');
    }
    
    // Check for educational context
    if (this.contextRules.educational.test(text)) {
      analysis.mitigatingFactors.push('educational');
    }
    
    // Check for news/reporting context
    if (this.contextRules.news.test(text)) {
      analysis.mitigatingFactors.push('news');
    }
    
    // Check for fictional context
    if (this.contextRules.fiction.test(text)) {
      analysis.mitigatingFactors.push('fiction');
    }
    
    // Check for support context
    if (this.contextRules.support.test(text)) {
      analysis.mitigatingFactors.push('support');
      
      // Self-harm with support context is allowed
      const selfharmIndex = violations.findIndex(v => v.type === 'selfharm');
      if (selfharmIndex !== -1) {
        analysis.mitigatingFactors.push('selfharm');
      }
    }
    
    // Check for sarcasm or negation
    const sarcasmIndicators = /\b(not|never|don't|won't|shouldn't|sarcasm|joking|kidding|lol|haha|😂|🙄)\b/i;
    if (sarcasmIndicators.test(text)) {
      // But check if it's being used to bypass
      const bypassPhrases = /just\s*(kidding|joking)|lol\s*jk|not\s*really/i;
      if (bypassPhrases.test(text) && violations.some(v => v.severity === 'high')) {
        analysis.additionalViolations.push({
          type: 'bypass_attempt',
          severity: 'critical',
          confidence: 0.8
        });
      }
    }
    
    return analysis;
  }
  
  levenshteinDistance(str1, str2) {
      const m = str1.length;
      const n = str2.length;
      const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
      
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (str1[i - 1] === str2[j - 1]) {
            dp[i][j] = dp[i - 1][j - 1];
          } else {
            dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
          }
        }
      }
      
      return dp[m][n];
    }

    // Add fuzzy matching for critical terms
checkFuzzyHarmfulWords(text) {
  const violations = [];
  const processText = text.slice(0, 500);

  if (processText.length < 3) return violations;

  // Check if we're in a context where fuzzy matching should be more lenient
  const context = this.checkLegitimateContext(text);
  const threshold = context.isLegitimate ? 0.85 : 0.80;
  
  // ADD: Check for metaphorical context EARLY
  const metaphoricalPatterns = [
    /\b(kill|killing|murder)\s*(this|that|it|the)\s*(presentation|meeting|interview|exam|test)/i,
    /\b(headache|pain|heat|cold|weather)\s*is\s*killing\s*me/i,
    /\b(kill|murder)\s*(for|a)\s*(coffee|drink|burger|pizza|food|meal)/i,
    /\b(mom|dad|parent|boss|teacher)\s*(will|gonna|going to)\s*(kill|murder)\s*me/i,
    /\bdie\s*(laughing|of\s*laughter|from\s*laughter)/i,
    /\b(joke|comedy|comedian)\s*bombed/i,
    /\bkill\s*(the\s*)?(lights|music|sound|engine|motor)/i,
    /\bliterally\s*(kill|die|murder)\s*for/i
  ];
  
  const isMetaphorical = metaphoricalPatterns.some(pattern => pattern.test(text));


      // Critical harmful words to check
    const criticalWords = {
      // Terrorism/Violence
      'bomb': { severity: 'critical', type: 'terrorism' },
      'explosive': { severity: 'critical', type: 'terrorism' },
      'detonate': { severity: 'critical', type: 'terrorism' },
      'ricin': { severity: 'critical', type: 'terrorism' },
      'sarin': { severity: 'critical', type: 'terrorism' },
      'anthrax': { severity: 'critical', type: 'terrorism' },
      
      // Threats
      'kill': { severity: 'high', type: 'threats' },
      'murder': { severity: 'high', type: 'threats' },
      'shoot': { severity: 'high', type: 'threats' },
      'stab': { severity: 'high', type: 'threats' },
      'strangle': { severity: 'high', type: 'threats' },
      'rape': { severity: 'high', type: 'threats' },
      'assault': { severity: 'high', type: 'threats' },
      
      // Self-harm
      'suicide': { severity: 'high', type: 'selfharm' },
      'overdose': { severity: 'high', type: 'selfharm' },
      
      // CSAM
      'molest': { severity: 'critical', type: 'csam' },
      'pedo': { severity: 'critical', type: 'csam' },
      'loli': { severity: 'critical', type: 'csam' },
      'csam': { severity: 'critical', type: 'csam' },
      
      // Illegal trade
      'cocaine': { severity: 'high', type: 'illegal_trade' },
      'heroin': { severity: 'high', type: 'illegal_trade' },
      'fentanyl': { severity: 'high', type: 'illegal_trade' },
      'meth': { severity: 'high', type: 'illegal_trade' },
      'ice' :  { severity: 'high', type: 'illegal_trade' },
      
      // Doxxing
      'address': { severity: 'high', type: 'doxxing' },
      'doxx': { severity: 'high', type: 'doxxing' },
      'swat': { severity: 'critical', type: 'doxxing' }
    };
    //slur words
      const slurWords = {
        'nigger': { severity: 'medium', type: 'hate_speech' },
        'faggot': { severity: 'medium', type: 'hate_speech' },
        'kike': { severity: 'medium', type: 'hate_speech' },
        'tranny': { severity: 'medium', type: 'hate_speech' },
        'dyke' : { severity: 'medium', type: 'hate_speech' },
        'poofter': { severity: 'medium', type: 'hate_speech' },
        'coon':  { severity: 'medium', type: 'hate_speech' },
        'chink':  { severity: 'medium', type: 'hate_speech' },
        'slut':  { severity: 'medium', type: 'hate_speech' },
        'whore':  { severity: 'medium', type: 'hate_speech' },
        'skag' :  { severity: 'medium', type: 'hate_speech' },
      };
    
        const normalized = this.unicodeNormalize(text);


  
  // Add more stop words
  const STOP_WORDS = new Set([
    'will', 'wall', 'well', 'fill', 'mill', 'bill', 'till',
    'shoot', 'shot', 'shoe', 'shop', 'show', // Common false positives for "shoot"
    'boot', 'foot', 'root', 'hoot'
  ]);
  
  const words = normalized.toLowerCase()
    .split(/[\s\W]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
      
  
  for (const word of words) {
    const dedupedWord = word.replace(/(.)\1+/g, '$1');

    for (const [harmfulWord, config] of Object.entries(criticalWords)) {
      const distance = this.levenshteinDistance(dedupedWord, harmfulWord);
      const similarity = 1 - (distance / Math.max(dedupedWord.length, harmfulWord.length));
      
      if (similarity >= threshold) {
        // ENHANCED: Skip threats/violence in metaphorical context
        if (isMetaphorical && ['threats', 'terrorism'].includes(config.type)) {
          continue;
        }
        
        // Existing context check...
        if (context.isLegitimate && context.type === 'creative' && 
            ['terrorism', 'threats'].includes(config.type)) {
          continue;
        }
        
        violations.push({
          type: config.type,
          severity: config.severity,
          confidence: similarity,
          match: word,
          similarTo: harmfulWord,
          method: 'fuzzy_match',
          contextType: context.type,
          contextConfidence: context.confidence
        });
      }
    }
  }
  
  return violations;
}
  
  
  analyzeBehavior(text, existingViolations) {
    const behavioral = [];
    
    // Grooming patterns
    const groomingPhrases = [
      /\b(don['’]t|dont)\s*tell\s*(?:\w+\s*)?(?:anyone|parents?|mom|dad)/i,
      /\b(our|my)\s*little\s*secret/i,
      /\b(special|mature)\s*for\s*your\s*age/i,
      /\bsend\s*(me|pics|photos|pictures)/i,
      /\b(meet|see)\s*you\s*(irl|in\s*real\s*life|in\s*person)/i,
      /\b(between|just)\s*(you\s*and\s*me|us)/i,
      /\byou['re\s]*(so\s*)?mature/i,
      /\b(no\s*one|nobody)\s*(understands|gets)\s*you\s*like\s*i\s*do/i,
      /\bi\s*can\s*(teach|show)\s*you/i,
      /\b(trust\s*me|you\s*can\s*trust)/i,
      /\bkeep\s*(this|it)\s*secret/i,
      /\bdelete\s*(this|these|the)\s*(message|chat|conversation)/i,
      /\byour\s*parents\s*(wouldn't|won't)\s*understand/i,
      /\bare\s*you\s*alone/i,
      /\bwhat\s*are\s*you\s*wearing/i,
      /\bsend\s*(me\s*)?(more|nude|naked)/i,
      /\b(young|little|small)\s*(girls?|boys?|kids?|children)\b.*\b(chat|talk|meet|private|dm)/i,
      /\b(under\s*18|minors?|underage).*\b(netflix|chill|meet|date)/i,
      /\bbarely\s*legal\b/i,
      /\b(teen|young|fresh)\s*\d{2}\b/i, // "teen 18", "fresh 18"
    ];
    
    let groomingScore = 0;
    for (const pattern of groomingPhrases) {
      if (pattern.test(text)) groomingScore++;
    }
    
    if (groomingScore >= 2) {
      behavioral.push({
        type: 'grooming_behavior',
        severity: 'high',
        confidence: Math.min(groomingScore * 0.3, 1.0)
      });
    }
    
    // Manipulation patterns
    const manipulationPhrases = [
      /\b(kill|hurt)\s*myself\s*if\s*you/i,
      /\byou\s*made\s*me\s*do\s*this/i,
      /\b(everyone|nobody)\s*(hates|likes)\s*you/i,
      /\byou\s*(deserve|caused)\s*this/i,
      /\bit['s\s]*your\s*fault/i,
      /\byou\s*made\s*me/i,
      /\bif\s*you\s*(really\s*)?loved\s*me/i,
      /\byou\s*owe\s*me/i,
      /\bafter\s*(all|everything)\s*i['ve\s]*done/i,
      /\byou['re\s]*nothing\s*without\s*me/i,
      /\bnobody\s*else\s*would\s*(want|love|date)\s*you/i,
      /\byou['re\s]*(crazy|insane|mental|psycho)/i,
      /\bi['m\s]*the\s*only\s*one\s*who/i,
      /\byou\s*deserve\s*(this|it|what)/i
    ];
    
    for (const pattern of manipulationPhrases) {
      if (pattern.test(text)) {
        behavioral.push({
          type: 'emotional_manipulation',
          severity: 'medium',
          confidence: 0.8
        });
        break;
      }
    }
    
    return behavioral;
  }
  
  downgradeSeverity(severity) {
    const levels = ['low', 'medium', 'high', 'critical'];
    const index = levels.indexOf(severity);
    return index > 0 ? levels[index - 1] : severity;
  }
  
deduplicateViolations(violations) {
  const obfuscationAttempt = violations.find(v => v.type === 'obfuscation_attempt');
  const specificThreat = violations.find(v => ['threats', 'terrorism', 'csam', 'selfharm'].includes(v.type));

  // If we found both an obfuscation attempt AND a specific underlying threat...
  if (obfuscationAttempt && specificThreat) {
    // And the obfuscation confidence is VERY high (>= 0.7), it means the
    // underlying threat is clear despite the obfuscation. Prioritize the threat.
    if (obfuscationAttempt.confidence >= 0.7) {
      return violations.filter(v => v.type !== 'obfuscation_attempt');
    }
    // Otherwise, the heavy obfuscation itself is the most important finding.
    // Prioritize the obfuscation attempt.
    else {
      return violations.filter(v => v.type !== specificThreat.type);
    }
  }

  // If the special cases above don't apply, fall back to the original simple deduplication.
  const seen = new Map();
  for (const violation of violations) {
    const key = `${violation.type}-${violation.severity}`;
    if (!seen.has(key) || violation.confidence > seen.get(key).confidence) {
      seen.set(key, violation);
    }
  }
  return Array.from(seen.values());
}
  
calculateVerdict(violations, contextAnalysis, text, nbcResult) {
    const CONTEXT_ALLOWED_TYPES = ['terrorism', 'hate_speech', 'threats'];
    const NEVER_MITIGATE = ['csam', 'doxxing', 'grooming_behavior'];
    
    if (violations.length === 0) {
        return { safe: true, shouldBlock: false, confidence: 1.0 };
    }

    // Early exit for extremely safe NBC + creative context
    if (nbcResult && nbcResult.label === 'safe' && nbcResult.probability > 0.999) {
        const hasCreativeContext = contextAnalysis.mitigatingFactors.some(
            f => ['fiction', 'creative', 'movie', 'game'].includes(f)
        );
        
        if (hasCreativeContext) {
            // Only keep violations that are absolutely not mitigatable
            const filteredViolations = violations.filter(v => 
                NEVER_MITIGATE.includes(v.type) || v.confidence > 0.95
            );
            
            if (filteredViolations.length === 0) {
                return { safe: true, shouldBlock: false, confidence: 1.0 };
            }
            
            violations = filteredViolations;
        }
    }

    const finalViolations = [];
    
    for (const violation of violations) {
        let mitigationLevel = 0;
        let newSeverity = violation.severity;
        
        // Factor 1: Enhanced NBC safe override with multiple tiers
        if (nbcResult && nbcResult.label === 'safe') {
            if (nbcResult.probability > 0.999) {
                mitigationLevel += 3; // Very strong confidence
            } else if (nbcResult.probability > 0.99) {
                mitigationLevel += 2; // Strong confidence
            } else if (nbcResult.probability > 0.95) {
                mitigationLevel += 1; // Moderate confidence
            }
        }
        
        // Factor 2: Enhanced context mitigation
        const contextScore = this.evaluateContextLegitimacy(text, contextAnalysis.mitigatingFactors);
        
        // Apply context mitigation to more violation types and methods
        if (!NEVER_MITIGATE.includes(violation.type) && contextScore > 0.6) {
            // Special handling for movie/creative content
            const hasMovieKeywords = /\b(movie|film|character|scene|actor|plot)\b/i.test(text);
            
            if (hasMovieKeywords && CONTEXT_ALLOWED_TYPES.includes(violation.type)) {
                mitigationLevel += 3; // Very strong mitigation for obvious movie content
            } else if (contextAnalysis.mitigatingFactors.includes('fiction') || 
                       contextAnalysis.mitigatingFactors.includes('creative') ||
                       contextAnalysis.mitigatingFactors.includes('movie')) {
                
                // For fuzzy matches and markov chains in creative contexts
                if (['fuzzy_match', 'markov_chain', 'ngram_analysis'].includes(violation.method)) {
                    if (CONTEXT_ALLOWED_TYPES.includes(violation.type)) {
                        mitigationLevel += 2; // Stronger mitigation for creative context
                    }
                }
                
                // For pattern matches in creative contexts
                if (!['fuzzy_match', 'markov_chain', 'ngram_analysis'].includes(violation.method)) {
                    if (CONTEXT_ALLOWED_TYPES.includes(violation.type)) {
                        mitigationLevel += 2; // Increased from 1 to 2
                    }
                }
            }

            // Add metaphorical/idiomatic mitigation
            if (contextAnalysis.mitigatingFactors.includes('metaphorical') || 
                contextAnalysis.mitigatingFactors.includes('idiomatic')) {
                if (violation.type === 'threats' || violation.type === 'selfharm') {
                    mitigationLevel += 4; // Very strong mitigation for obvious idioms
                }
            }

            // News context
            if (contextAnalysis.mitigatingFactors.includes('news') && 
                ['terrorism', 'threats'].includes(violation.type)) {
                mitigationLevel++;
            }
        }
        
        // Stage 2: Apply downgrades (but cap the mitigation)
        if (mitigationLevel > 0) {
            let severityLevels = ['low', 'medium', 'high', 'critical'];
            let currentLevelIndex = severityLevels.indexOf(newSeverity);
            // Increased cap from 3 to 4 to allow critical->low
            let downgrades = Math.min(mitigationLevel, 4);
            let newLevelIndex = Math.max(0, currentLevelIndex - downgrades);
            newSeverity = severityLevels[newLevelIndex];
        }
        
        finalViolations.push({ ...violation, severity: newSeverity });
    }
    
    // Stage 3: Make final decision based on adjusted severities
    const critical = finalViolations.filter(v => v.severity === 'critical');
    if (critical.length >= 1) {
        return { safe: false, shouldBlock: true, confidence: Math.max(...critical.map(v => v.confidence)) };
    }
    
    const high = finalViolations.filter(v => v.severity === 'high');
    if (high.length >= 1) {
        return { safe: false, shouldBlock: true, confidence: Math.max(...high.map(v => v.confidence)) };
    }
    
    const medium = finalViolations.filter(v => v.severity === 'medium');
    
    // Don't block on ML-only medium violations
    if (medium.length > 0) {
        // Separate ML violations from rule-based violations
        const mlViolations = medium.filter(v => 
            v.type === 'ml_flagged' || v.method === 'markov_chain'
        );
        const ruleViolations = medium.filter(v => 
            v.type !== 'ml_flagged' && 
            v.method !== 'markov_chain' &&
            v.type !== 'harmful_sequence' // Don't count markov as rule violation
        );

        // For hate speech, single medium violation should block
        if (ruleViolations.some(v => v.type === 'hate_speech')) {
            return { 
                safe: false, 
                shouldBlock: true, 
                confidence: Math.max(...ruleViolations.map(v => v.confidence)) 
            };
        }

        // Only block if we have rule-based violations
        if (ruleViolations.length > 0) {
            // Multiple rule violations OR high confidence single violation
            if (ruleViolations.length > 1 || ruleViolations.some(v => v.confidence > 0.9)) {
                return { 
                    safe: false, 
                    shouldBlock: true, 
                    confidence: Math.max(...ruleViolations.map(v => v.confidence)) 
                };
            }
        }
        
        // If we only have ML violations, don't block even if there are multiple
        // This prevents "gonna go eat a sandwich" from being blocked
    }
    
    return {
        safe: false,
        shouldBlock: false,
        confidence: Math.max(...violations.map(v => v.confidence))
    };
}
  
  generateCacheKey(text) {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }
  
  updateCache(key, result) {
    // LRU cache implementation
    if (this.cache.size >= this.config.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, {
      safe: result.safe,
      violations: result.violations,
      shouldBlock: result.shouldBlock,
      timestamp: Date.now()
    });
  }
  
  updateMetrics(result, checkTime) {
    if (!this.config.enableMetrics) return;
    
    this.metrics.totalChecks++;
    
    if (result.shouldBlock) {
      this.metrics.blockedContent++;
    }
    
    for (const violation of result.violations) {
      const count = this.metrics.detectionsByCategory.get(violation.type) || 0;
      this.metrics.detectionsByCategory.set(violation.type, count + 1);
    }
    
    // Update average check time
    this.metrics.averageCheckTime = 
      (this.metrics.averageCheckTime * (this.metrics.totalChecks - 1) + checkTime) / 
      this.metrics.totalChecks;
    
    if (result.metadata?.obfuscationScore > 0.5) {
      this.metrics.obfuscationAttempts++;
    }
  }
  
  /**
   * Get current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      cacheHitRate: this.cacheHits / (this.cacheHits + this.cacheMisses),
      topViolations: Array.from(this.metrics.detectionsByCategory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
    };
  }
  
  /**
   * Quick check method for performance-critical paths
   */
  quickCheck(text) {
    // Only check critical patterns without normalization
    const violations = [];
    
    for (const [category, config] of this.compiledPatterns.get('critical')) {
      for (const pattern of config.patterns) {
        if (pattern.test(text)) {
          violations.push({
            type: category,
            severity: 'critical',
            confidence: 1.0
          });
          break;
        }
      }
    }
    
  const verdict = this.calculateVerdict(violations);
  return {
    safe: verdict.safe,
    shouldBlock: verdict.shouldBlock,
    violations,
  };
  }
  
  /**
   * Export configuration for persistence
   */
  exportConfig() {
    return {
      version: '2.0.0',
      config: this.config,
      metrics: this.getMetrics(),
      customPatterns: this.config.customPatterns
    };
  }
  
  /**
   * Import configuration
   */
  importConfig(exported) {
    if (exported.version !== '2.0.0') {
      throw new Error('Incompatible configuration version');
    }
    
    this.config = { ...this.config, ...exported.config };
    this.initializePatterns();
    this.compiledPatterns = this.compilePatterns();
  }
}

// Export singleton instance
export const contentSafety = new ContentSafetySystem();
