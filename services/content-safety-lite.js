// services/content-safety.js
/**
 * Enterprise-grade Content Safety System
 * 
 * Features:
 * - Multi-layered pattern matching with complexity analysis
 * - Advanced obfuscation detection (leetspeak, unicode, spacing, etc.)
 * - Context-aware analysis with sliding windows
 * - Multilingual harmful content detection
 * - Behavioral pattern recognition
 * - Performance optimized with caching and early exits
 * - Comprehensive logging and metrics
 * - Configurable severity thresholds
 * 
 * @version 2.0.0
 * @license GPL
 */

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
      }
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
            /\b(cp|csam|csa|child[\s_-]*(porn|sex|abuse|exploitation)|child\s*sexual\s*abuse)\b/i,
            /\b(pedo|paedo|p3do|ped0|map|nop)|pthc\b/i,
            /\b(loli|shota|cub|toddlercon|babycon|prete?en|under[-\s]*age|jail\s*bait)\b/i,
            /\b(minor|kid|child)[\s\S]{0,25}(sex|nude|porn|pics?|vids?|naked|rape|abuse)\b/i,
            /\b\d{1,2}\s*(yo|yrs?|year[-\s]*old)[\s\S]{0,25}(nudes?|sex|porn|pics?|vids?)\b/i,
            /\b(toddler|infant|baby)[\s\S]{0,25}(sex|abuse|rape|molest)\b/i,
            /\b(she|he|they)\s*(is|are)\s*(a|an)?\s*(underage|minor|child|kid)\s*(girl|boy|child)?\b/i
          ],
          contextRules: {
            requiresContext: false,
            falsePositiveKeywords: ['report', 'news', 'arrest', 'convicted']
          }
        },
        
        // Imminent violence/terrorism
        terrorism: {
          patterns: [
            /\b(make|build|assemble|cook|mix|prepare)[\s\S]{0,30}(bomb|ied|pipe[\s_-]*bomb|molotov|napalm|explosive|device|detonator)\b/i,
            /\b(terror|terrorist|extremist|jihad)[\s\S]{0,25}(attack|plan|manual|guide|training|recruit|cell)\b/i,
            /\b(isis|daesh|al[-\s]*qaeda|taliban|al[-\s]*shabaab|hamas|hezbollah)[\s\S]{0,25}(join|contact|pledge|bayat|support)\b/i,
            /\b(suicide|mass|school|car|truck|church|synagogue)[\s\S]{0,20}(bomb|attack|shoot(?:ing)?|massacre)\b/i,
            /\b(how\s*to|guide|tutorial|recipe)[\s\S]{0,25}(make|build|synthesize)[\s\S]{0,25}(ricin|sarin|anthrax|chloroform|tnt|black\s*powder|nitro(?:glycerin)?)\b/i,
            /\bhow\s+to.{0,20}(bomb|poison|kill\s+many)/i,
            /\b(?:how\s*to\s*)?(?:make|build|create|construct)\s*(?:a\s*)?b[o0]m[b8]/i,
            /\b(ricin|sarin|anthrax).{0,20}(make|create|obtain)/i,
            /\b(blueprint|schematic|formula)[\s\S]{0,25}(bomb|weapon|explosive)\b/i
          ],
          contextRules: {
            requiresContext: true,
            exceptions: ['news', 'history', 'fiction', 'game']
          }
        },
        
        // Doxxing/Privacy violations
        doxxing: {
          patterns: [
            /\b(dox+x?ing?|swat(?:ting)?|drop(?:pin[g]?|ping)?\s*docs?)\b/i,
            /\b(real|home|personal|private|current|exact)\s*(address|add\.?|location|loc|coords?)\b/i,
            /\b(leak(?:ed)?|reveal(?:ed)?|expose(?:d)?|publish(?:ed)?)[\s\S]{0,20}(address|phone|number|email|info|docs?)\b/i,
            /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/, // SSN
            /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // Email
            /\b\d{1,5}\s+[\w\s]{1,50}\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|plaza|blvd)\b/i,
            /\b(apt|apartment|unit|suite|#)\s*\d+/i,
            /\b\d{5}(-\d{4})?\b/, // ZIP code with context
            /\b(lat|latitude|long|longitude)\s*:?\s*-?\d+\.\d+/i
          ],
          contextRules: {
            requiresContext: true,
            mustInclude: ['live', 'home', 'find', 'location', 'address']
          }
        }
      },
      
      high: {
        // Direct threats
        threats: {
          patterns: [
            /\b(kill|murder|slaughter|eliminate|erase|shoot|stab|strangle|decapitate|behead|burn|torch).{0,25}(you|u|ur|ya|your|family|kin|kids)\b/i,
            /\b(i['’]m\s*going\s*to|i\s*will|gonna|about\s*to|fixin(?:g)?\s*to).{0,25}(kill|hurt|beat|break|mess\s*you\s*up|ruin|destroy|shoot)\b/i,
            /\b(you['’]ll|you\s*will|you['’]re\s*going\s*to).{0,25}(die|bleed|suffer|pay|regret)\b/i,
            /\b(find|track|hunt|locate|trace).{0,25}(you|u|ya).{0,25}(down|irl|soon|tonight)\b/i,
            /\bwatch.{0,20}(your|ur).{0,20}back/i,
            /\b(burn|firebomb).{0,25}(house|home|car)\b/i,
            /\b(fuck|rape|sexual(?:ly)?\sassault).{0,25}(you|ya|ur|your)\b/i
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
            /\b(kill|end|take).{0,20}(myself|my\s*life|own\s*life)/i,
            /\b(cut|harm|hurt).{0,20}(myself|self)/i,
            /\bsuicid(e|al)/i,
            /\b(want|going|planning).{0,20}die\b/i,
            /\b(method|way|how).{0,20}(suicide|kill\s*myself)/i,
            /\b(bridge|cliff|building).{0,20}(jump|leap)/i,
            /\b(overdose|od|pills).{0,20}(take|swallow)/i,
            /\b(kys|kill\s*yourself|end\s*yourself)/i, 
          ],
          contextRules: {
            supportPhrases: ['help', 'hotline', 'support', 'prevention'],
            requiresPersonalContext: true
          }
        },
        
        // Illegal markets
        illegal_trade: {
          patterns: [
            /\b(sell|buy|deal).{0,20}(meth|cocaine|heroin|fentanyl|mdma|lsd)/i,
            /\b(drug|narcotics).{0,20}(dealer|supplier|plug)/i,
            /\b(weapon|gun|firearm).{0,20}(sell|buy|illegal)/i,
            /\b(fake|forged).{0,20}(passport|id|document)/i,
            /\b(credit\s*card|cc).{0,20}(dump|fullz|cvv)/i,
            /\b(hitman|assassin|killer).{0,20}(hire|need|contact)/i,
            /\bdark\s*web.{0,20}(market|vendor|link)/i
          ],
          contextRules: {
            transactionWords: ['bitcoin', 'crypto', 'payment', 'escrow', 'ship']
          }
        },
        
        financial_scams: {
          patterns: [
            /\b(wire|send|transfer)\s*(money|funds|bitcoin|crypto)/i,
            /\b(nigerian?\s*prince|inheritance|lottery\s*win)/i,
            /\byour\s*(account|card)\s*(has\s*been|was)\s*(compromised|hacked)/i,
            /\bclick\s*here\s*to\s*(verify|confirm|secure)/i,
            /\b(irs|tax)\s*(fraud|evasion|warrant)/i,
            /\bgift\s*card\s*(payment|number|code)/i
          ],
          contextRules: {
            requiresContext: true,
            transactionWords: ['payment', 'urgent', 'immediately', 'expire']
          }
        },

        sextortion: {
          patterns: [
            /\bi\s*have\s*(your|compromising)\s*(video|photos?|pictures?)/i,
            /\b(pay|send)\s*(me|bitcoin|money)\s*or\s*i['ll\s]*(share|post|send)/i,
            /\byour\s*(webcam|camera)\s*was\s*(hacked|compromised)/i,
            /\bi\s*know\s*your\s*password/i,
            /\b(share|send)\s*this\s*to\s*(your|all)\s*(contacts|friends|family)/i
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
            /\b(nigger|nigga|faggot|fag|kike|spic|chink|gook|wetback|towelhead|tranny|slut|whore|bitch|cunt|skag|skank|nigg|niggs|nigs|poof|poofter|poofta)/i,
            /\b(all|every).{0,20}(blacks|whites|jews|muslims|christians|gays|hindus|indians|africans).{0,20}(should|must|need)/i,
            /\b(holocaust|slavery).{0,20}(good|deserved|fake|hoax)/i,
            /\b(hitler|nazi).{0,20}(right|correct|good)/i,
            /\b(jews|jew|jewish).{0,20}(right|correct|good)/i,
            /\b(arab|arabs|muslims|islam).{0,20}(right|correct|good)/i,
            /\b(gas|burn|lynch).{0,20}(whites|browns|arabs|muslims|christians|straights|bisexuals|jews|blacks|gays|hindus)/i
          ],
          contextRules: {
            educationalContext: ['history', 'education', 'documentary', 'quoting'],
            reclamation: ['self-identify', 'reclaim', 'our word']
          }
        },
        
        // Targeted harassment
        harassment: {
          patterns: [
            /\b(kys|kill\s*yourself|end\s*yourself)/i,
            /\b(retard|retarded|autist|autistic).{0,20}(you|u\s*r|dumb)/i,
            /\b(ugly|fat|disgusting).{0,20}(bitch|whore|slut)/i,
            /\b(rope|neck|hang).{0,20}yourself/i,
            /\bno\s*one.{0,20}(likes|loves|wants).{0,20}you/i,
            /\b(worthless|useless|waste).{0,20}(life|space|person)/i
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
            /\b(click|visit|check\s*out).{0,20}(link|site|here)/i,
            /\b(earn|make).{0,20}\$\d+.{0,20}(day|hour|week)/i,
            /\b(viagra|cialis|pills).{0,20}(cheap|discount|sale)/i,
            /\b(crypto|bitcoin|nft).{0,20}(pump|moon|10x)/i,
            /(.)\1{10,}/, // Character spam
            /[A-Z\s]{20,}/, // CAPS spam
            /\b(\w{4,})\b(?=.*?\b\1\b.*?\b\1\b.*?\b\1\b)/i, // A word of 4+ chars repeated at least 4 times
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
        check: (text) => {
          const reversed = text.split('').reverse().join('');
          return this.checkContentInternal(reversed, { skipCache: true });
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
    addMapping('i', 'ì', 'í', 'î', 'ï', 'ĩ', 'ī', 'ĭ', 'į', 'ı', 'ǐ', 'ɨ', 'ɩ', 'ɪ', 'ι', 'і', 'ї');
    addMapping('j', 'ĵ', 'ǰ', 'ɉ', 'ʝ', 'ⱼ', 'ᶡ', 'ᶨ', 'й', 'ј');
    addMapping('k', 'ķ', 'ĸ', 'ǩ', 'ḱ', 'ḳ', 'ḵ', 'ƙ', 'ⱪ', 'ᵏ', 'ᶄ', 'κ', 'к');
    addMapping('l', 'ĺ', 'ļ', 'ľ', 'ŀ', 'ł', 'ḷ', 'ḹ', 'ḻ', 'ḽ', 'ℓ', 'ʟ', 'ˡ', 'ᴸ', 'ᶫ', 'л');
    addMapping('m', 'ḿ', 'ṁ', 'ṃ', 'ɱ', 'ᵐ', 'ᴹ', 'ᶬ', 'м', 'μ');
    addMapping('n', 'ñ', 'ń', 'ņ', 'ň', 'ŋ', 'ṅ', 'ṇ', 'ṉ', 'ṋ', 'ɲ', 'ɳ', 'ᴺ', 'ⁿ', 'ᶮ', 'ᶯ', 'ᶰ', 'н', 'η', 'ν');
    addMapping('o', 'ò', 'ó', 'ô', 'õ', 'ö', 'ø', 'ō', 'ŏ', 'ő', 'ǒ', 'ǫ', 'ǭ', 'ɵ', 'ο', 'о', 'ө', 'ᵒ', 'ᴼ', 'ᶱ');
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
  const compiled = new Map();
  
  // First compile standard patterns
  for (const [severity, categories] of Object.entries(this.harmPatterns)) {
    compiled.set(severity, new Map());
    
    for (const [category, config] of Object.entries(categories)) {
      const patterns = config.patterns.map(pattern => {
        if (pattern instanceof RegExp) {
          return new RegExp(pattern.source, pattern.flags.includes('u') ? pattern.flags : pattern.flags + 'u');
        }
        return pattern;
      });
      
      compiled.get(severity).set(category, {
        patterns,
        contextRules: config.contextRules
      });
    }
  }
  
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
            /\b(novel|story|book|script|screenplay)\b/i,
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
  
  // 4. Detect obfuscation attempts (renumber from 3)
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
  // 5. Normalize text through multiple passes
  const normalizations = this.getNormalizedVariants(text);
  
  // 6. Check each normalization
  for (const normalized of normalizations) {
    const patternViolations = this.checkPatterns(normalized.text, text, normalized.method);
    violations.push(...patternViolations);
  }
  
  // 7. Context analysis (your existing code)
if (this.config.enableContextAnalysis && violations.length > 0) {
    contextAnalysis = this.analyzeContext(text, violations);
    
    for (const violation of violations) {
        // CRITICAL: Only allow context mitigation for specific types
        const CONTEXT_ALLOWED_TYPES = ['terrorism', 'hate_speech'];
        
        // Direct threats, CSAM, self-harm should NEVER be mitigated
        const NEVER_MITIGATE = ['threats', 'csam', 'doxxing', 'grooming_behavior', 'selfharm'];
        
        if (NEVER_MITIGATE.includes(violation.type)) {
            continue; // Skip context mitigation entirely
        }
        
        if (!CONTEXT_ALLOWED_TYPES.includes(violation.type)) {
            continue; // Only specific types can be mitigated
        }
        
        // Check if context is legitimate
        const contextScore = this.evaluateContextLegitimacy(text, contextAnalysis.mitigatingFactors);
        
        if (contextScore > 0.7) { // High confidence it's legitimate context
            const rules = this.harmPatterns[violation.severity]?.[violation.type]?.contextRules;
            if (rules?.exceptions) {
                for (const factor of contextAnalysis.mitigatingFactors) {
                    const exceptionMap = {
                        educational: 'history',
                        news: 'news',
                        fiction: 'fiction'
                    };
                    if (exceptionMap[factor] && rules.exceptions.includes(exceptionMap[factor])) {
                        violation.contextMitigation = true;
                        violation.mitigationConfidence = contextScore;
                        break;
                    }
                }
            }
        }
    }
    
    violations.push(...contextAnalysis.additionalViolations);
}
  
  // 8. Behavioral analysis
  const behavioral = this.analyzeBehavior(text, violations);
  violations.push(...behavioral);
  
  // 9. Remove duplicates and determine final verdict
  const uniqueViolations = this.deduplicateViolations(violations);
  const finalVerdict = this.calculateVerdict(uniqueViolations);
  
  return {
    safe: finalVerdict.safe,
    violations: uniqueViolations,
    shouldBlock: finalVerdict.shouldBlock,
    confidence: finalVerdict.confidence,
    metadata: {
      obfuscationScore: obfuscation.score,
      normalizationMethods: normalizations.map(n => n.method),
      contextualFactors: this.config.enableContextAnalysis ? contextAnalysis : null
    }
  };
}

checkNgramSimilarity(text) {
  const violations = [];
  
  // Only process first 500 chars for n-gram analysis
  const processText = text.slice(0, 500).toLowerCase();
  
  // Skip if text is too short
  if (processText.length < 10) return violations;
  
  // Generate trigrams more carefully
  const generateTrigrams = (str) => {
    const trigrams = new Set();
    // Only use alphanumeric to avoid false matches
    const cleaned = str.replace(/[^a-z0-9]/g, '');
    for (let i = 0; i <= cleaned.length - 3; i++) {
      trigrams.add(cleaned.slice(i, i + 3));
    }
    return trigrams;
  };
  
  // Harmful trigram signatures
const harmfulSignatures = {
  // Terrorism/Explosives
  'bom': { word: 'bomb', type: 'terrorism', severity: 'critical' },
  'omb': { word: 'bomb', type: 'terrorism', severity: 'critical' },
  'exp': { word: 'explosive', type: 'terrorism', severity: 'critical' },
  'plo': { word: 'explosive', type: 'terrorism', severity: 'critical' },
  'det': { word: 'detonate', type: 'terrorism', severity: 'critical' },
  'ton': { word: 'detonate', type: 'terrorism', severity: 'critical' },
  'ric': { word: 'ricin', type: 'terrorism', severity: 'critical' },
  'sar': { word: 'sarin', type: 'terrorism', severity: 'critical' },
  'thr': { word: 'anthrax', type: 'terrorism', severity: 'critical' },
  
  // Violence/Threats
  'kil': { word: 'kill', type: 'threats', severity: 'high' },
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
  
  // Self-harm
  'sui': { word: 'suicide', type: 'selfharm', severity: 'high' },
  'uic': { word: 'suicide', type: 'selfharm', severity: 'high' },
  'ici': { word: 'suicide', type: 'selfharm', severity: 'high' },
  'cid': { word: 'suicide', type: 'selfharm', severity: 'high' },
  'ide': { word: 'suicide', type: 'selfharm', severity: 'high' },
  'ove': { word: 'overdose', type: 'selfharm', severity: 'high' },
  'ver': { word: 'overdose', type: 'selfharm', severity: 'high' },
  'dos': { word: 'overdose', type: 'selfharm', severity: 'high' },
  
  // CSAM
  'mol': { word: 'molest', type: 'csam', severity: 'critical' },
  'les': { word: 'molest', type: 'csam', severity: 'critical' },
  'ped': { word: 'pedo', type: 'csam', severity: 'critical' },
  'edo': { word: 'pedo', type: 'csam', severity: 'critical' },
  'lol': { word: 'loli', type: 'csam', severity: 'critical' },
  'oli': { word: 'loli', type: 'csam', severity: 'critical' },
  'csa': { word: 'csam', type: 'csam', severity: 'critical' },
  'sam': { word: 'csam', type: 'csam', severity: 'critical' },
  
  // Drugs
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
  
  // Doxxing
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
  
  // KEY CHANGE: Only check exact trigram matches, NO Levenshtein distance
  for (const trigram of textTrigrams) {
    if (harmfulSignatures[trigram]) {
      const config = harmfulSignatures[trigram];
      const currentCount = wordMatches.get(config.word) || 0;
      wordMatches.set(config.word, currentCount + 1);
    }
  }
  
  // KEY CHANGE: Require at least 2 matching trigrams 
  for (const [word, count] of wordMatches) {
    if (count >= 2) {
      const config = Object.values(harmfulSignatures).find(h => h.word === word);
      
        violations.push({
          type: config.type,
          severity: config.severity,
          confidence: Math.min(count * 0.1, 0.8), // Reduced confidence
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
    return text
      .toLowerCase()
      .replace(/[._\-*\/\\|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  
  unicodeNormalize(text) {
    let normalized = '';

    // 1. Iterate character by character and replace using the map.
    // This is more reliable than chained regex replacements.
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
    normalized = normalized.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    return normalized;
}
  
  
    
    
  quickEvasionCheck(text) {
      const violations = [];
      
      // Common evasion patterns that should trigger immediate flags
      const evasionPhrases = [
        { pattern: /b[0o]m[b8]/i, type: 'terrorism', severity: 'critical' },
        { pattern: /k[i1!]+l+/i, type: 'threats', severity: 'high' },
        { pattern: /k[i1!]ll\s*y[o0]u/i, type: 'threats', severity: 'high' },
        { pattern: /su[i1!]c[i1!]d[e3]/i, type: 'selfharm', severity: 'high' },
        { pattern: /[ck]ill[sz]?\s*[ck]ids?/i, type: 'threats', severity: 'critical' },
        { pattern: /\d{1,2}\s*y[o0]/i, type: 'csam', severity: 'critical' },
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
    let normalized = this.unicodeNormalize(text);
    
    // Remove all non-alphanumeric except spaces
    normalized = normalized.replace(/[^a-z0-9\s]/g, '');
    
    // Collapse repeated characters
    normalized = normalized.replace(/(.)\1{2,}/g, '$1$1');
    
    // Remove single characters between words
    normalized = normalized.replace(/\b\w\b/g, '');
    
    return normalized.trim();
  }
  
  phoneticNormalize(text) {
    let normalized = this.basicNormalize(text);
    
    // Common phonetic substitutions
    const phonetic = {
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
  const paddedText = ` ${normalizedText} `;

  // Strip accents/diacritics and re-test “threat” patterns on the clean text.
  const asciiText = this.unicodeNormalize(originalText);
  if (asciiText !== originalText) {
    const threatConfig = this.compiledPatterns.get('high').get('threats');
    for (const pattern of threatConfig.patterns) {
      if (pattern.test(asciiText)) {
        return [{
          type: 'threats',
          severity: 'high',
          pattern,
          normalizationMethod: 'unicode',
          confidence: 0.9
        }];
      }
    }
  }

  // First check if we're in a legitimate context that should override most checks
  const legitimateContext = this.checkLegitimateContext(originalText);
  
  for (const [severity, categories] of this.compiledPatterns) {
    for (const [category, config] of categories) {
      // Skip certain checks entirely in legitimate contexts
      if (legitimateContext.isLegitimate && this.shouldSkipInContext(category, legitimateContext)) {
        continue;
      }
      
      for (const pattern of config.patterns) {
        const matches = normalizedText.match(pattern) || paddedText.match(pattern);
        
        if (matches) {
          // Check context rules
          if (config.contextRules) {
          // ——— Pattern-specific context rules ———
          if (config.contextRules) {
            // 1) “requiresContext” must pass
            if (config.contextRules.requiresContext) {
              const hasCtx = this.checkRequiredContext(originalText, config.contextRules);
              if (!hasCtx) continue;
            }
            // 2) if this context is in the “exceptions” list, skip it
            if (config.contextRules.exceptions &&
                config.contextRules.exceptions.includes(legitimateContext.type)) {
              continue;
            }
          }
            
            if (config.contextRules.exceptions) {
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
          
          break; // One match per category
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
  
  // Need at least 3 news indicators for legitimate context
  return matches >= 3;
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
  
  return matches >= 3;
}

isLegitimateCreativeContext(text) {
  const creativePatterns = [
    /\b(chapter|scene|act|episode)\s*\d+/i,
    /\b(character|protagonist|antagonist|hero|villain)\b/i,
    /\b(novel|story|book|script|screenplay|plot)\b/i,
    /\b(game|gaming|player|npc|quest|mission|level)\b/i,
    /"[^"]+"\s*(said|asked|replied|shouted|whispered)/i,
    /\b(fiction|fantasy|sci-fi|thriller|drama)\b/i
  ];
  
  let matches = 0;
  for (const pattern of creativePatterns) {
    if (pattern.test(text)) matches++;
  }
  
  // For gaming, be more lenient
  if (/\b(call\s*of\s*duty|fortnite|minecraft|gta|game)\b/i.test(text)) {
    matches += 2;
  }
  
  return matches >= 3 && text.length > 50;
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

shouldSkipInContext(category, context) {
  const contextExemptions = {
    news: ['terrorism', 'hate_speech', 'threats', 'illegal_trade'],
    educational: ['terrorism', 'hate_speech', 'illegal_trade'],
    creative: ['threats', 'illegal_trade'],
    support: ['selfharm'] // This allows suicide discussion in support contexts
  };
  
  // For gaming contexts, be more specific
  if (context.type === 'creative' && category === 'threats') {
    // Check if it's actually about in-game violence
    const gameViolencePattern = /\b(game|gaming|player|character|enemy|mission)\b/i;
    if (gameViolencePattern.test(context.type)) {
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
      
      // Doxxing
      'address': { severity: 'high', type: 'doxxing' },
      'doxx': { severity: 'high', type: 'doxxing' },
      'swat': { severity: 'critical', type: 'doxxing' }
    };
        const normalized = this.unicodeNormalize(text);

  // Check if we're in a context where fuzzy matching should be more lenient
  const context = this.checkLegitimateContext(text);
  const threshold = context.isLegitimate ? 0.85 : 0.70; // Higher threshold for legitimate contexts
  
  // Add more stop words
  const STOP_WORDS = new Set([
    'will', 'wall', 'well', 'fill', 'mill', 'bill', 'till',
    'shoot', 'shot', 'shoe', 'shop', 'show', // Common false positives for "shoot"
    'boot', 'foot', 'root', 'hoot'
  ]);
  
  const words = normalized.toLowerCase()
    .split(/[\s\W]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
      
      for (const word of words) {
        for (const [harmfulWord, config] of Object.entries(criticalWords)) {
          const distance = this.levenshteinDistance(word, harmfulWord);
          const similarity = 1 - (distance / Math.max(word.length, harmfulWord.length));
          
          // If similarity is above 0.80, flag it
          if (similarity >= 0.80) {
            violations.push({
              type: config.type,
              severity: config.severity,
              confidence: similarity,
              match: word,
              similarTo: harmfulWord,
              method: 'fuzzy_match'
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
      /\bsend\s*(me\s*)?(more|nude|naked)/i
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
  
 calculateVerdict(violations) {
    if (violations.length === 0) {
        return { safe: true, shouldBlock: false, confidence: 1.0 };
    }
    
    // Filter out violations that have been mitigated
    const activeSeverityViolations = violations.filter(v => !v.contextMitigation);
    
    if (activeSeverityViolations.length === 0) {
        return { safe: true, shouldBlock: false, confidence: 0.5 };
    }
      const onlyLowSeverity = violations.every(v => v.severity === 'low');
      if (onlyLowSeverity) {
        return { safe: false, shouldBlock: false, confidence: 0.5 };
      }
    // Check for critical violations
    const critical = activeSeverityViolations.filter(v => v.severity === 'critical');
    if (critical.length >= 1) {
        return {
            safe: false,
            shouldBlock: true,
            confidence: Math.max(...critical.map(v => v.confidence))
        };
    }
    
    // Check for high severity - USE activeSeverityViolations NOT violations!
    const high = activeSeverityViolations.filter(v => v.severity === 'high');
    if (high.length >= 1) {
        return {
            safe: false,
            shouldBlock: true,
            confidence: Math.max(...high.map(v => v.confidence))
        };
    }
    
    // Check for medium severity - USE activeSeverityViolations NOT violations!
    const medium = activeSeverityViolations.filter(v => v.severity === 'medium');
    if (medium.length > 1) {
        return {
            safe: false,
            shouldBlock: false,
            confidence: Math.max(...medium.map(v => v.confidence))
        };
    }
    
    // Otherwise, flag but don't block
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
