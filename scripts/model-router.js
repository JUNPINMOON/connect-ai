#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const envPaths = require("./env-paths.js");

function defaultPolicyDir() {
    if (process.env.CONNECT_AI_MODEL_ROUTER_DIR) return process.env.CONNECT_AI_MODEL_ROUTER_DIR;
    return path.join(envPaths.companyDir(), "model-router");
}

class ModelRouter {
    constructor(options = {}) {
        this.repoRoot = path.resolve(__dirname, "..");
        this.policyDir = path.resolve(options.policyDir || defaultPolicyDir());
        this.policyPath = options.policyPath || path.join(this.policyDir, "model-policy.md");
        this.routingRules = this.loadRoutingRules();
    }

    loadRoutingRules() {
        const rules = {
            // Task type classification
            taskTypes: {
                analysis: {
                    patterns: [
                        /분석|analyze|investigate|research|리서치|조사|검토|review/i,
                        /\b(data|데이터)\s*(analysis|분석)/i,
                        /\b(trend|트렌드)\s*(analysis|분석)/i
                    ],
                    defaultModel: "codex",
                    riskLevel: "low"
                },
                implementation: {
                    patterns: [
                        /구현|implement|build|create|개발|develop|만들어|coding|코딩/i,
                        /\b(code|코드)\s*(write|작성|생성)/i,
                        /\b(script|스크립트)\s*(create|생성)/i
                    ],
                    defaultModel: "codex",
                    riskLevel: "medium"
                },
                publishing: {
                    patterns: [
                        /게시|publish|post|업로드|upload|공유|share/i,
                        /\b(youtube|유튜브)\s*(upload|업로드)/i,
                        /\b(content|콘텐츠)\s*(publish|게시)/i
                    ],
                    defaultModel: "codex",
                    riskLevel: "high",
                    requiresApproval: true
                },
                sensitive: {
                    patterns: [
                        /민감|sensitive|secret|비밀|credential|인증|api.*key/i,
                        /\b(password|비밀번호)\b/i,
                        /\b(token|토큰)\s*(refresh|secret)/i,
                        /\b(env|환경변수)\s*(config|설정)/i
                    ],
                    defaultModel: "claude",
                    riskLevel: "high",
                    requiresApproval: true
                }
            },

            // Risk assessment
            riskLevels: {
                low: {
                    autoApprove: true,
                    maxRetries: 3,
                    timeoutSeconds: 180
                },
                medium: {
                    autoApprove: true,
                    maxRetries: 2,
                    timeoutSeconds: 300,
                    requiresVerification: true
                },
                high: {
                    autoApprove: false,
                    maxRetries: 1,
                    timeoutSeconds: 600,
                    requiresApproval: true,
                    auditTrail: true
                }
            },

            // Model capabilities
            modelCapabilities: {
                "codex": {
                    strengths: ["coding", "implementation", "analysis", "research"],
                    limitations: ["high_stakes_decisions", "sensitive_data"],
                    maxContextTokens: 128000,
                    costLevel: "low"
                },
                "claude": {
                    strengths: ["design", "review", "complex_reasoning", "sensitive_data"],
                    limitations: ["none"],
                    maxContextTokens: 200000,
                    costLevel: "high"
                },
                "local": {
                    strengths: ["quick_tasks", "simple_analysis"],
                    limitations: ["complex_reasoning", "external_apis"],
                    maxContextTokens: 32000,
                    costLevel: "free"
                }
            }
        };
        
        return rules;
    }

    classifyTask(taskDescription) {
        const task = taskDescription.toLowerCase();
        
        // Check each task type
        for (const [taskType, config] of Object.entries(this.routingRules.taskTypes)) {
            for (const pattern of config.patterns) {
                if (pattern.test(task)) {
                    return {
                        type: taskType,
                        model: config.defaultModel,
                        risk: config.riskLevel,
                        requiresApproval: config.requiresApproval || false
                    };
                }
            }
        }

        // Default classification
        return {
            type: "general",
            model: "codex",
            risk: "low",
            requiresApproval: false
        };
    }

    assessRisk(taskClassification, context = {}) {
        const riskConfig = this.routingRules.riskLevels[taskClassification.risk];
        
        // Additional risk factors
        let riskScore = 0;
        const factors = [];

        // Check for destructive operations
        if (context.includesDestructive) {
            riskScore += 2;
            factors.push("destructive_operations");
        }

        // Check for external API calls
        if (context.includesExternalAPIs) {
            riskScore += 1;
            factors.push("external_apis");
        }

        // Check for large file operations
        if (context.largeFileOperations) {
            riskScore += 1;
            factors.push("large_files");
        }

        // Adjust risk level based on score
        let finalRisk = taskClassification.risk;
        if (riskScore >= 2 && finalRisk !== "high") {
            finalRisk = "high";
        } else if (riskScore >= 1 && finalRisk === "low") {
            finalRisk = "medium";
        }

        return {
            level: finalRisk,
            config: this.routingRules.riskLevels[finalRisk],
            factors,
            score: riskScore
        };
    }

    routeTask(taskDescription, context = {}) {
        // Classify the task
        const classification = this.classifyTask(taskDescription);
        
        // Assess risk
        const risk = this.assessRisk(classification, context);
        
        // Get model capabilities
        const modelCap = this.routingRules.modelCapabilities[classification.model];
        
        // Generate routing decision
        const routing = {
            taskId: this.generateTaskId(),
            timestamp: new Date().toISOString(),
            task: {
                description: taskDescription,
                classification: classification.type,
                complexity: this.estimateComplexity(taskDescription)
            },
            routing: {
                selectedModel: classification.model,
                modelCapabilities: modelCap,
                alternativeModels: this.getAlternativeModels(classification.model, classification.type)
            },
            risk: {
                level: risk.level,
                factors: risk.factors,
                config: risk.config,
                requiresApproval: classification.requiresApproval || risk.config.requiresApproval
            },
            execution: {
                autoApprove: risk.config.autoApprove,
                maxRetries: risk.config.maxRetries,
                timeoutSeconds: risk.config.timeoutSeconds,
                requiresVerification: risk.config.requiresVerification
            }
        };

        return routing;
    }

    estimateComplexity(taskDescription) {
        const complexityIndicators = {
            low: [
                /simple|기본|단순|quick|빠른|easy|쉬운/i,
                /\b(one|1)\s+(line|line|줄)/i
            ],
            medium: [
                /moderate|중간|several|여러|multiple|여러개/i,
                /\b(few|few|몇)\s+(lines|줄)/i
            ],
            high: [
                /complex|복잡|advanced|고급|comprehensive|종합적/i,
                /\b(many|many|많은)\s+(lines|줄|files|파일)/i
            ]
        };

        const task = taskDescription.toLowerCase();
        
        for (const [level, patterns] of Object.entries(complexityIndicators)) {
            for (const pattern of patterns) {
                if (pattern.test(task)) {
                    return level;
                }
            }
        }

        return "medium";
    }

    getAlternativeModels(primaryModel, taskType) {
        const alternatives = [];
        
        // Get all models that can handle this task type
        for (const [model, cap] of Object.entries(this.routingRules.modelCapabilities)) {
            if (model !== primaryModel && cap.strengths.includes(taskType)) {
                alternatives.push({
                    model,
                    strengths: cap.strengths,
                    costLevel: cap.costLevel
                });
            }
        }

        return alternatives;
    }

    generateTaskId() {
        return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    updatePolicy(newRules) {
        // Merge new rules with existing ones
        this.routingRules = { ...this.routingRules, ...newRules };
        
        // Save a runtime policy snapshot. Durable Obsidian notes must go through
        // vault-writer/memory-bridge, not this router helper.
        const policyContent = this.generatePolicyDocument();
        fs.mkdirSync(path.dirname(this.policyPath), { recursive: true });
        fs.writeFileSync(this.policyPath, policyContent);
    }

    generatePolicyDocument() {
        return `# model-policy
어떤 일에 어떤 모델을 쓸지 라우팅. 분류=로컬/Haiku, 일본=[[Codex]], 고난도=[[Claude]]. [[정책 게이트]].

## 자동 라우팅 규칙 (업데이트: ${new Date().toISOString()})

### 작업 유형 분류
${Object.entries(this.routingRules.taskTypes).map(([type, config]) => `
#### ${type}
- 기본 모델: ${config.defaultModel}
- 리스크 레벨: ${config.riskLevel}
- 승인 필요: ${config.requiresApproval ? '예' : '아니오'}
- 패턴: ${config.patterns.map(p => p.toString()).join(', ')}
`).join('')}

### 리스크 레벨 설정
${Object.entries(this.routingRules.riskLevels).map(([level, config]) => `
#### ${level}
- 자동 승인: ${config.autoApprove ? '예' : '아니오'}
- 최대 재시도: ${config.maxRetries}
- 타임아웃: ${config.timeoutSeconds}초
${config.requiresVerification ? '- 검증 필요: 예' : ''}
${config.requiresApproval ? '- 승인 필요: 예' : ''}
${config.auditTrail ? '- 감사 추적: 예' : ''}
`).join('')}

### 모델 능력
${Object.entries(this.routingRules.modelCapabilities).map(([model, cap]) => `
#### ${model}
- 강점: ${cap.strengths.join(', ')}
- 제한: ${cap.limitations.join(', ')}
- 최대 컨텍스트: ${cap.maxContextTokens} 토큰
- 비용 레벨: ${cap.costLevel}
`).join('')}
`;
    }
}

// CLI interface
function main() {
    const router = new ModelRouter();
    const command = process.argv[2];

    switch (command) {
        case "route":
            if (!process.argv[3]) {
                console.error("Usage: model-router.js route \"<task description>\"");
                process.exit(1);
            }
            const taskDescription = process.argv.slice(3).join(" ");
            const routing = router.routeTask(taskDescription);
            console.log(JSON.stringify(routing, null, 2));
            break;

        case "classify":
            if (!process.argv[3]) {
                console.error("Usage: model-router.js classify \"<task description>\"");
                process.exit(1);
            }
            const classification = router.classifyTask(process.argv.slice(3).join(" "));
            console.log(JSON.stringify(classification, null, 2));
            break;

        case "rules":
            console.log(JSON.stringify(router.routingRules, null, 2));
            break;

        default:
            console.log("Model Router - Automatic Model Routing");
            console.log("Commands:");
            console.log("  route \"<task>\"        - Route a task and show full routing decision");
            console.log("  classify \"<task>\"      - Classify task type only");
            console.log("  rules                  - Show current routing rules");
            break;
    }
}

if (require.main === module) {
    main();
}

module.exports = ModelRouter;
