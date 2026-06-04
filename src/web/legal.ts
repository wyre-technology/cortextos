/**
 * Legal pages — Terms of Service and Privacy Policy
 *
 * Served as standalone pages (no auth required) with minimal styling.
 */

import type { FastifyInstance } from 'fastify';
import { PAGE_STYLES } from './styles.js';

const LEGAL_STYLES = `
  ${PAGE_STYLES}
  body { max-width: 740px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-family: var(--font-heading); font-size: 28px; margin: 0 0 8px; }
  h2 { font-family: var(--font-heading); font-size: 20px; margin: 32px 0 12px; color: var(--text-primary); }
  p, li { line-height: 1.7; color: var(--text-secondary); margin: 0 0 12px; }
  ul { padding-left: 20px; margin: 0 0 16px; }
  a { color: var(--accent-text); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .updated { font-size: 13px; color: var(--text-muted); margin-bottom: 24px; }
  .brand { font-family: var(--font-heading); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 32px; }
  .brand a { color: var(--text-muted); text-decoration: none; }
  .brand a:hover { color: var(--text-secondary); }
  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border-subtle); font-size: 13px; color: var(--text-muted); }
  .footer a { color: var(--accent-text); }
`;

function legalPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — WYRE Technology</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@400;500;600&family=Nunito+Sans:wght@300;400;600;700&display=swap" rel="stylesheet" />
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>${LEGAL_STYLES}</style>
</head>
<body>
  <div class="brand"><a href="/">WYRE Technology &middot; MCP Gateway</a></div>
  ${content}
  <div class="footer">
    <a href="/terms">Terms of Service</a> &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="/msa">AI Services Attachment</a> &middot; <a href="/">Home</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Terms of Service
// ---------------------------------------------------------------------------

const TERMS_CONTENT = `
<p class="updated">Last updated: April 9, 2026</p>
<h1>Terms of Service</h1>
<p>These terms govern your use of MCP Gateway, operated by WYRE Technology, LLC ("WYRE", "we", "us", "our"). By using MCP Gateway, you agree to these terms.</p>

<h2>1. What MCP Gateway Is</h2>
<p>MCP Gateway is a secure proxy service that connects AI assistants (such as Claude) to managed service provider (MSP) tools including ConnectWise, Autotask, Hudu, Datto RMM, and others via the Model Context Protocol (MCP). The gateway stores your vendor API credentials on your behalf and proxies API requests between your AI assistant and your connected tools.</p>

<h2>2. Acceptance of Terms</h2>
<p>By creating an account or using MCP Gateway, you agree to be bound by these Terms of Service. If you are using MCP Gateway on behalf of an organization, you represent that you have authority to bind that organization to these terms. If you do not agree, do not use the service.</p>

<h2>3. Account Registration and Security</h2>
<p>To use MCP Gateway, you must authenticate via Microsoft Entra ID or another supported identity provider. You are responsible for:</p>
<ul>
  <li>Maintaining the security of your account and authentication credentials</li>
  <li>All activity that occurs under your account</li>
  <li>Ensuring that the vendor API credentials you provide are authorized for use with the service</li>
  <li>Notifying us promptly at <a href="mailto:legal@wyretechnology.com">legal@wyretechnology.com</a> if you believe your account has been compromised</li>
</ul>

<h2>4. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Use MCP Gateway to access vendor APIs in a manner that violates those vendors' terms of service</li>
  <li>Attempt to gain unauthorized access to MCP Gateway systems, other users' accounts, or connected vendor systems</li>
  <li>Scrape, crawl, or extract data from MCP Gateway for purposes unrelated to your legitimate use</li>
  <li>Use the service to transmit malware, spam, or any harmful content</li>
  <li>Circumvent rate limits, authentication controls, or other protective measures</li>
  <li>Resell or redistribute access to MCP Gateway without our written permission</li>
  <li>Use the service in any way that violates applicable laws or regulations</li>
</ul>

<h2>5. Intellectual Property</h2>
<p><strong>Our platform:</strong> WYRE Technology owns all rights to the MCP Gateway platform, including its software, design, documentation, and branding. These terms do not grant you any rights to our intellectual property beyond the limited right to use the service.</p>
<p><strong>Your data:</strong> You retain all rights to your data, including the vendor API credentials you provide and the data that flows through the gateway. We claim no ownership over your data.</p>

<h2>6. Data Handling</h2>
<p>We take the security of your data seriously:</p>
<ul>
  <li>Vendor API credentials are encrypted at rest using AES-256 encryption</li>
  <li>All data in transit is protected with TLS</li>
  <li>API requests are proxied in real time and not permanently stored (request logs retained up to 90 days for audit)</li>
  <li>We do not access your vendor data except as necessary to operate the proxy service</li>
</ul>
<p>For full details, see our <a href="/privacy">Privacy Policy</a>.</p>

<h2>7. Service Availability</h2>
<p>We make commercially reasonable efforts to maintain monthly availability of MCP Gateway at or above 99.5%. Availability is measured at the gateway's externally-facing endpoints over a calendar-month window. The 99.5% number is grounded in a measured baseline window and is subject to honest caveats — see the published <a href="/sla">Service Level Agreement</a> for the basis of the commitment, the §4 caveats, and the response-time matrix for support requests.</p>
<p>The service may experience scheduled or unscheduled downtime for maintenance, updates, or unforeseen issues; events excluded from the availability calculation are documented in the SLA.</p>
<p>We reserve the right to modify, suspend, or discontinue any part of the service. If we discontinue the service entirely, we will provide at least 30 days' notice and help you export or delete your stored credentials.</p>

<h2>8. Pricing and Billing</h2>
<p>MCP Gateway is offered on a flat monthly subscription. The published rate is <strong>$399 per organization per month</strong> as a base fee, plus <strong>$39 per billable seat per month</strong>. Billable seats include every human team member and any service-client (agent) seat beyond the first two included with the base fee. Pricing is the same for every organization — no separate tiers or usage credits.</p>
<p>New organizations may start with a <strong>14-day free trial</strong> of the full platform. The trial converts to a paid subscription when a payment method is added through our payment processor, or closes automatically at the end of the trial period if no payment method is on file.</p>
<p>Subscriptions are invoiced monthly in advance. We will notify existing customers at least 30 days in advance of any material change to the published rate, and you will not be charged at a new rate without explicit consent. The full AI Services governance (acceptance, data rights, termination, and renewal) is published as the <a href="/msa">AI Services Service Attachment</a> and applies to your use of any AI-related capabilities of MCP Gateway.</p>

<h2>9. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, WYRE Technology shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of MCP Gateway.</p>
<p>Our total liability for any claim shall not exceed the amount you paid us in the twelve months preceding the claim, or $100, whichever is greater.</p>
<p>MCP Gateway proxies requests to third-party vendor APIs. We are not responsible for the availability, accuracy, or behavior of those third-party services.</p>

<h2>10. Indemnification</h2>
<p>You agree to indemnify and hold harmless WYRE Technology from any claims, damages, or expenses arising from your use of the service, your violation of these terms, or your violation of any third party's rights.</p>

<h2>11. Termination</h2>
<p><strong>By you:</strong> You may stop using MCP Gateway at any time. Request deletion of your account and data at <a href="mailto:legal@wyretechnology.com">legal@wyretechnology.com</a>.</p>
<p><strong>By us:</strong> We may suspend or terminate your access if you violate these terms, if required by law, or if we discontinue the service. We will make reasonable efforts to notify you beforehand.</p>
<p><strong>Effect:</strong> Upon termination, your stored credentials will be deleted. You may request a data export before termination takes effect.</p>

<h2>12. Modification of Terms</h2>
<p>We may update these terms. When we make material changes, we will notify you at least 30 days in advance via email or a notice within the service.</p>

<h2>13. Governing Law</h2>
<p>These terms are governed by the laws of the State of Tennessee. Any disputes will be resolved in the state or federal courts located in Hamilton County, Tennessee.</p>

<h2>14. Contact</h2>
<p>WYRE Technology, LLC<br>Chattanooga, TN<br><a href="mailto:legal@wyretechnology.com">legal@wyretechnology.com</a></p>
`;

// ---------------------------------------------------------------------------
// Privacy Policy
// ---------------------------------------------------------------------------

const PRIVACY_CONTENT = `
<p class="updated">Last updated: April 9, 2026</p>
<h1>Privacy Policy</h1>
<p>This policy explains how WYRE Technology, LLC ("WYRE", "we", "us") collects, uses, and protects your information when you use MCP Gateway.</p>

<h2>1. Information We Collect</h2>
<p><strong>Account information:</strong> When you sign in via Microsoft Entra ID or Auth0, we receive your email address, display name, and organization identifier. We do not receive or store your Microsoft or identity provider password.</p>
<p><strong>Vendor API credentials:</strong> You provide API keys, tokens, or other credentials for the third-party tools you connect. These are encrypted at rest with AES-256 and stored in our database.</p>
<p><strong>Usage data:</strong> We log which tools are called, timestamps, and response metadata for audit and debugging. Request logs are retained for up to 90 days. We do not log the full content of API responses from your vendor tools.</p>
<p><strong>Organization data:</strong> If you create or join a team, we store the organization name, membership list, role assignments, and team structure.</p>

<h2>2. How We Use Your Information</h2>
<ul>
  <li><strong>Authentication:</strong> Verify your identity and manage access</li>
  <li><strong>Proxying:</strong> Inject your vendor credentials into API requests on your behalf</li>
  <li><strong>Audit logging:</strong> Provide your organization with a record of tool usage</li>
  <li><strong>Billing:</strong> Process payments when paid plans are introduced (via Stripe)</li>
  <li><strong>Communication:</strong> Send transactional emails (invitations, welcome, security notices) via Resend</li>
  <li><strong>Improvement:</strong> Understand usage patterns to improve the service (aggregated, not individual)</li>
</ul>

<h2>3. Data Storage and Security</h2>
<ul>
  <li>Hosted on Microsoft Azure (East US 2 region)</li>
  <li>Vendor credentials encrypted at rest with AES-256 using a hardware-secured master key</li>
  <li>All connections encrypted in transit with TLS 1.2+</li>
  <li>Database access restricted to the gateway application via network-level controls</li>
  <li>No vendor data is cached or stored beyond the duration of a proxied request</li>
</ul>

<h2>4. Third-Party Services</h2>
<p>We use the following third-party services:</p>
<ul>
  <li><strong>Microsoft Entra ID / Auth0:</strong> User authentication</li>
  <li><strong>Stripe:</strong> Payment processing (when paid plans are active)</li>
  <li><strong>Resend:</strong> Transactional email delivery</li>
  <li><strong>Azure Container Apps:</strong> Application hosting</li>
  <li><strong>Azure Database for PostgreSQL:</strong> Data storage</li>
</ul>
<p>Each of these services has its own privacy policy. We only share the minimum information necessary for each service to function.</p>

<h2>5. Data Retention</h2>
<ul>
  <li><strong>Vendor credentials:</strong> Stored until you delete them or your account is terminated</li>
  <li><strong>Audit logs:</strong> Retained for 90 days, then automatically deleted</li>
  <li><strong>Request logs:</strong> Retained for 90 days, then automatically deleted</li>
  <li><strong>Account information:</strong> Retained while your account is active; deleted upon request</li>
</ul>

<h2>6. Your Rights</h2>
<p>You can:</p>
<ul>
  <li><strong>Access</strong> your stored data via the gateway dashboard and API</li>
  <li><strong>Correct</strong> your information by updating your profile or credentials</li>
  <li><strong>Delete</strong> your vendor credentials, organization, or entire account at any time</li>
  <li><strong>Export</strong> your data via the gateway API</li>
</ul>
<p>To exercise any of these rights, use the gateway dashboard or contact <a href="mailto:privacy@wyretechnology.com">privacy@wyretechnology.com</a>.</p>

<h2>7. Cookies and Local Storage</h2>
<p>MCP Gateway uses:</p>
<ul>
  <li><strong>Session cookie</strong> (<code>gateway_session</code>): Signed, HTTP-only cookie for authentication. Expires when you close your browser or log out.</li>
  <li><strong>Theme preference</strong> (<code>gateway-theme</code>): Stored in localStorage to remember your light/dark mode choice. Not transmitted to our servers.</li>
</ul>
<p>We do not use tracking cookies, analytics pixels, or third-party advertising cookies.</p>

<h2>8. Children's Privacy</h2>
<p>MCP Gateway is not directed at children under 13. We do not knowingly collect information from children. If you believe a child has provided us with personal information, contact us at <a href="mailto:privacy@wyretechnology.com">privacy@wyretechnology.com</a>.</p>

<h2>9. International Data Transfers</h2>
<p>MCP Gateway is hosted in the United States. If you access the service from outside the US, your information will be transferred to and processed in the US. By using the service, you consent to this transfer.</p>

<h2>10. Changes to This Policy</h2>
<p>We may update this privacy policy from time to time. When we make material changes, we will notify you via email or a notice within the service. The "Last updated" date at the top reflects the most recent revision.</p>

<h2>11. Contact</h2>
<p>WYRE Technology, LLC<br>Chattanooga, TN<br><a href="mailto:privacy@wyretechnology.com">privacy@wyretechnology.com</a></p>
`;

// ---------------------------------------------------------------------------
// AI Services Service Attachment (MSA)
//
// Identical-in-substance to the canonical PDF maintained at
//   https://docs.ourterms.live/WYRE/AI-Attachment.pdf
// (8 pages, effective April 24, 2024, authored by Scott & Scott, LLP and
// adopted by WYRE Technology as its AI-Services policy text).
//
// LOCKSTEP-SYNCHRONY REQUIREMENT (pearl-confirmed 2026-06-03 per
// WYREAI-98): the click-to-accept at signup captures a SHA256 hash of
// the canonical-PDF bytes. If this page and the PDF drift, users see one
// set of bytes while the cryptographic-evidence layer records a
// different set — a real consent-integrity risk in both directions.
// When the canonical PDF updates:
//   1. PDF lands first at docs.ourterms.live.
//   2. Re-extract via pdftotext: curl PDF | pdftotext -layout - -
//   3. Diff against MSA_CONTENT below; apply (preserving the About
//      blockquote, Continuing-acceptance section, Contact section,
//      and Scott & Scott LLP attribution at the foot).
//   4. Bump the "Effective:" date in the .updated line at top.
//   5. Verify pearl's SHA-at-click pickup catches the new PDF bytes.
// The 5-step sequence is the canonical-form republishing protocol;
// skipping any step risks consent-integrity drift.
// ---------------------------------------------------------------------------

const MSA_CONTENT = `
<p class="updated">Effective: April 24, 2024 (canonical PDF: <a href="https://docs.ourterms.live/WYRE/AI-Attachment.pdf">docs.ourterms.live/WYRE/AI-Attachment.pdf</a>)</p>
<p style="border-left:3px solid var(--accent-text); padding:8px 16px; background:var(--bg-subtle, rgba(0,201,219,0.04)); margin:16px 0;"><strong>About this page.</strong> This is the policy text WYRE Technology has adopted for AI Services it provides to its customers. It is identical in substance to the canonical PDF maintained at <a href="https://docs.ourterms.live/WYRE/AI-Attachment.pdf">docs.ourterms.live/WYRE/AI-Attachment.pdf</a>; the page exists so the policy is searchable, link-stable, and reachable without a PDF reader. In any apparent conflict, the canonical PDF governs. <strong>Effective:</strong> April 24, 2024. This Service Attachment for Artificial Intelligence Services supersedes and replaces all prior versions. <strong>Provider / Client.</strong> Where this Attachment refers to "Provider," that means <strong>WYRE Technology</strong>. "Client" means the customer named on the applicable Order.</p>
<p>This Service Attachment is between Provider (sometimes referred to as "we," "us," or "our"), and Client found on the applicable Order (sometimes referred to as "you," or "your"), and, together with the Order, Master Services Agreement, Schedule of Services, and other relevant Service Attachments, forms the Agreement between the parties — the terms to which the parties agree to be bound.</p>
<p>Provider will deliver only the Services itemized in the Services section of the Order. The following is a list of available Services. Additional Services may be added only by entering into a new Order including those Services.</p>
<p>The parties further agree as follows:</p>
<h2>Definitions</h2>
<p>For the purposes of this Service Attachment, the following terms shall have the meanings specified below:</p>
<ul>
  <li><strong>"AI Services"</strong> refers to the artificial intelligence-based services provided by the Provider under this Agreement, including but not limited to AI-driven analytics, process automation, Client interaction services, and AI application development.</li>
  <li><strong>"AI-Generated Outputs"</strong> means any data, content, analyses, or other materials generated by the AI Services as a result of processing Client's data or through interactions with Client's systems.</li>
  <li><strong>"AI Models"</strong> refers to the computational models developed or used by the Provider that simulate human intelligence processes, including machine learning models, neural networks, and algorithms.</li>
  <li><strong>"Client Data"</strong> means any data, information, or material provided by Client to the Provider for the purpose of receiving the AI Services, including but not limited to operational data, Client information, and business intelligence.</li>
  <li><strong>"Data Sources"</strong> refers to the origins of data used by the AI Services, which may include Client Data, publicly available data, and data from third-party providers.</li>
  <li><strong>"Implementation Support"</strong> encompasses the services provided by the Provider to assist Client in integrating and deploying the AI Services within Client's operational environment, including vendor and technology selection, proof of concept development, and implementation oversight.</li>
  <li><strong>"Innovation Workshops"</strong> are collaborative sessions conducted by the Provider with Client's teams to explore potential AI use cases, innovative applications, and strategic planning for AI deployment.</li>
  <li><strong>"Machine Learning"</strong> is a subset of AI that involves the development of algorithms allowing computers to learn and make decisions based on data, without being explicitly programmed for each specific task.</li>
  <li><strong>"Strategic AI Consulting"</strong> involves advisory services provided by the Provider aimed at evaluating Client's readiness for AI integration, developing AI strategies aligned with business objectives, and facilitating innovation workshops.</li>
  <li><strong>"Technical Support"</strong> refers to the support services provided by the Provider to address technical issues, troubleshoot problems, and ensure the continuous operation of the AI Services, as specified in the Agreement.</li>
  <li><strong>"Third-Party Components"</strong> means software, data, or services not developed or owned by the Provider but used in the delivery of the AI Services, including open source software and third-party APIs.</li>
</ul>
<h2>Services</h2>
<p>Provider shall provide the following AI Technology Consulting Services to Client under the terms of this Agreement:</p>
<h3>Strategic AI Consulting</h3>
<ul>
  <li><strong>AI Readiness Assessment.</strong> Provider shall evaluate Client's existing technological infrastructure, data readiness, and organizational culture to assess Client's readiness for AI integration, documenting findings in a readiness report.</li>
  <li><strong>AI Strategy Development.</strong> Provider shall assist Client in developing a strategic plan for AI deployment that is aligned with Client's business objectives. This plan will identify key areas where AI can add substantial value to Client's operations.</li>
  <li><strong>Innovation Workshops.</strong> Provider will conduct sessions with Client's teams to facilitate the identification of potential AI use cases and innovative applications that are particularly relevant to Client's industry and specific business challenges.</li>
</ul>
<h3>AI Solution Design and Planning</h3>
<ul>
  <li><strong>Use Case Identification and Prioritization.</strong> Provider shall collaborate with Client to identify, assess, and prioritize AI use cases based on their potential business impact and technical feasibility.</li>
  <li><strong>Solution Architecture Design.</strong> Provider is responsible for designing the architecture of AI solutions, including the selection of suitable AI models and technologies, establishing data pipelines, and ensuring seamless integration with existing systems of Client.</li>
  <li><strong>Roadmap Development.</strong> Provider shall develop a phased implementation roadmap, detailing key milestones, resource requirements, and timelines for the effective deployment of AI solutions.</li>
</ul>
<h3>Implementation Support</h3>
<ul>
  <li><strong>Vendor and Technology Selection.</strong> Provider shall advise Client on selecting the most appropriate AI technologies and vendors, taking into account Client's specific use cases, budget, and existing infrastructure.</li>
  <li><strong>Proof of Concept (PoC) Development.</strong> Provider shall assist in the development and execution of PoCs to validate the feasibility and potential impact of the proposed AI solutions before proceeding to full-scale implementation.</li>
  <li><strong>Implementation Oversight.</strong> Provider shall provide oversight and expert guidance during the implementation of AI projects to ensure they are aligned with the strategic vision and adhere to technical standards.</li>
</ul>
<h3>Training and Change Management</h3>
<ul>
  <li><strong>AI Literacy Training.</strong> Provider shall offer training sessions aimed at enhancing the AI literacy of Client's workforce, covering fundamental AI concepts, tools, and best practices.</li>
  <li><strong>Change Management Support.</strong> Provider shall assist with change management efforts to facilitate the smooth adoption of AI technologies, addressing any cultural shifts, skill gaps, and necessary workflow adjustments.</li>
</ul>
<h3>Data Governance and Ethics</h3>
<ul>
  <li><strong>Data Strategy Consulting.</strong> Provider shall advise on the creation of a comprehensive data strategy that ensures the integrity, accessibility, and security of data utilized in AI solutions.</li>
  <li><strong>AI Ethics and Compliance.</strong> Provider shall provide guidance on ethical AI usage, including measures for bias mitigation, ensuring transparency, and adherence to relevant regulations and standards.</li>
</ul>
<h3>Performance Measurement and Optimization</h3>
<ul>
  <li><strong>KPIs and Metrics Definition.</strong> Provider shall assist Client in defining key performance indicators (KPIs) and metrics to evaluate the effectiveness and impact of AI initiatives.</li>
  <li><strong>Continuous Improvement.</strong> Provider commits to providing ongoing support to optimize AI solution performance based on analytics, identifying areas for enhancement.</li>
</ul>
<h3>Future Trends and Innovation</h3>
<ul>
  <li><strong>Emerging Technologies Advisory.</strong> Provider shall keep Client informed about emerging AI technologies and trends that may affect their business or provide new opportunities for innovation.</li>
  <li><strong>Innovation Roadmapping.</strong> Provider shall assist Client in periodically updating their AI strategy and roadmap to include new technologies and approaches.</li>
</ul>
<h3>AI-Driven Client Interaction Services</h3>
<p>Provider will develop and deploy custom AI chatbots and voice assistants, integrate AI-driven Client interaction tools, and provide ongoing training and support. These services are designed to enhance Client service, personalize Client experiences, and optimize Client journey.</p>
<h3>Process Automation Services</h3>
<p>Provider shall offer process mapping, custom automation solutions, and integration services to automate repetitive tasks and streamline operations. This includes document processing automation, email automation, and support for continuous process improvement.</p>
<h3>AI Application Development</h3>
<p>Provider will design custom AI applications, integrating AI workflows into Client's operations, and provide an app builder tool for customization. Ongoing support, updates, and training will ensure the applications meet Client's evolving needs.</p>
<h2>Acceptance Testing</h2>
<p><strong>Acceptance Testing.</strong> Upon completion of the deployment phase of any AI Service or upon the delivery of any custom AI development, the Provider shall notify Client that the service or development is ready for Acceptance Testing.</p>
<p><strong>Testing Period.</strong> Client shall have a period of 15 business days from the date of such notification to conduct Acceptance Testing. Provider shall provide reasonable support to Client during this period, including access to necessary documentation, tools, and technical assistance.</p>
<p><strong>Scope.</strong> Acceptance Testing shall cover all functional, performance, and integration aspects of the AI Services as detailed in the service specifications of this Agreement. Client shall use reasonable and industry-standard testing methods appropriate for the services being tested.</p>
<p><strong>Acceptance Criteria.</strong> The AI Services will be deemed to have passed Acceptance Testing and thus be accepted by Client if:</p>
<ul>
  <li>The services perform in accordance with the functional specifications and performance standards set forth in the Order.</li>
  <li>No critical defects are identified that would significantly impact Client's ability to use the services for their intended purpose.</li>
  <li>Minor defects or non-critical issues identified during Acceptance Testing shall be documented and scheduled for correction by the Provider, but will not preclude acceptance of the AI Services.</li>
</ul>
<p><strong>Testing Failure.</strong> If Client determines that the AI Services have not passed Acceptance Testing, Client shall notify the Provider in writing within [insert number of days] days of completion of the Testing Period, detailing the deficiencies or defects found. Upon receipt of such notification, the Provider shall have 30 business days to correct the identified deficiencies and resubmit the services for Acceptance Testing.</p>
<p><strong>Rejection.</strong> If after three attempts, the AI Services still fail to meet the Acceptance Criteria, Client may either:</p>
<ul>
  <li>Reject the AI Services and terminate this Agreement with respect to the failed services without penalty, or</li>
  <li>Agree to accept the AI Services with deficiencies, possibly subject to a negotiated reduction in fees or other remedial measures.</li>
</ul>
<p><strong>Acceptance.</strong> Upon acceptance of the AI Services, whether initially or after correction of deficiencies, Client shall provide the Provider with a written statement that the AI Services are accepted. Acceptance of the AI Services shall not waive any of Client's rights under the warranty provisions of this Agreement or limit Provider's obligations to address any subsequently discovered defects.</p>
<h2>Provider Obligations</h2>
<p><strong>Compliance and Standards.</strong> Provider shall ensure that all services are performed in compliance with applicable laws, regulations, and industry standards, particularly those relating to data protection, privacy, and AI ethics. Provider agrees to maintain all necessary licenses, certifications, and authorizations required to perform the services.</p>
<p><strong>Data Protection and Security.</strong> Provider will implement and maintain robust security measures to protect Client's data against unauthorized access, disclosure, alteration, or destruction. Provider will notify Client promptly of any data breaches or security incidents that impact Client's data.</p>
<p><strong>Customization and Integration.</strong> Provider shall work with Client to customize and integrate AI-driven services into Client's existing systems and workflows as necessary to meet Client's business needs. Provider will reasonably assist Client with required system modifications or integrations related to the service delivery. There may be an additional charge for these services.</p>
<p><strong>Performance Monitoring and Reporting.</strong> Provider will monitor the performance of the AI-driven services and provide Client with periodic reports detailing usage, performance metrics, and insights into potential improvements.</p>
<p><strong>Issue Resolution and Escalation.</strong> Provider shall establish an issue resolution and escalation process to promptly address any service-related issues or concerns raised by Client.</p>
<p><strong>Innovation and Advice.</strong> Provider will advise Client on emerging AI technologies and innovations that could enhance Client's business operations or offer new opportunities for growth and efficiency.</p>
<h2>Client Obligations</h2>
<p>Client agrees to the following obligations:</p>
<p><strong>Provision of Information.</strong> Client shall provide all necessary information regarding its current systems, software, and hardware that the Provider deems necessary for the provision of AI services. Client agrees to promptly disclose any changes in operational processes, technology infrastructure, or business objectives that might impact the services provided by the Provider.</p>
<p><strong>Access and Assistance.</strong> Client shall grant the Provider and its authorized personnel access to its facilities, systems, and information as required for the purpose of delivering the services. Client agrees to offer reasonable assistance, including the availability of Client's personnel, for consultations, meetings, and implementation activities related to the services.</p>
<p><strong>Data Provision and Quality.</strong> Client is responsible for providing data necessary for the AI services. The data must meet the quality standards specified by the Provider, including accuracy, completeness, and relevancy. Client shall ensure that it has the right to use and provide such data to the Provider for the purpose of delivering the services, adhering to applicable data protection and privacy laws.</p>
<p><strong>Compliance with Laws.</strong> Client is responsible for ensuring that its use of the AI services complies with all applicable laws, regulations, and industry standards. This includes data protection and privacy laws, intellectual property rights laws, and any specific regulations governing Client's industry.</p>
<p><strong>Security and Confidentiality.</strong> Client shall implement reasonable security measures to protect access to its systems and the data used in conjunction with the AI services. Client agrees to maintain the confidentiality of any proprietary information or tools provided by the Provider as part of the services.</p>
<p><strong>Cooperation and Coordination.</strong> Client will cooperate with the Provider in good faith and coordinate internally to facilitate the effective delivery and implementation of the AI services. This includes timely feedback and decision-making to support project timelines.</p>
<p><strong>Ethical Use of AI.</strong> Client agrees to use the AI services and any related technologies ethically, in a manner that respects privacy rights, avoids discrimination, and complies with ethical guidelines provided by the Provider.</p>
<p><strong>Notification of Issues.</strong> Client shall promptly notify the Provider of any issues, concerns, or malfunctions related to the AI services. Client agrees to provide detailed information about such issues to aid in their resolution.</p>
<h2>Intellectual Property</h2>
<p><strong>Ownership of Pre-Existing Intellectual Property.</strong> Each party retains all right, title, and interest in and to its pre-existing intellectual property, including without limitation any software, data, or material owned by either party prior to the execution of this Agreement. Client grants the Provider a non-exclusive, worldwide, royalty-free license to use Client's pre-existing intellectual property solely for the purpose of performing the services under this Agreement.</p>
<p><strong>AI-Generated Outputs.</strong> Client shall own the intellectual property rights in any data, content, or materials generated by AI services specifically for Client's use under this Agreement, subject to any third-party rights in the underlying data or algorithms. <strong>Use of Outputs:</strong> Client is responsible for ensuring that the use of AI-generated outputs complies with applicable laws, including copyright, patent, and trademark laws, and does not infringe upon the intellectual property rights of third parties.</p>
<p><strong>Custom Developments.</strong> Any developments, including custom AI models, algorithms, or applications, specifically created by Provider for Client under this Agreement, shall be owned by Client, provided that Client pays all fees associated with such development as agreed upon. Provider shall retain the right to use general knowledge, skills, and experience, including non-Client-specific developments, gained during the performance of this Agreement.</p>
<p><strong>Third-Party Materials and Open-Source Software.</strong> Provider may use third-party materials, including open-source software, in the development or delivery of AI services. Provider shall ensure that such use complies with the respective licenses and does not impose any unagreed obligations on Client. Provider shall inform Client of the use of any third-party materials that require attribution or impose restrictions on the use of AI-generated outputs.</p>
<p><strong>Licenses to Provider.</strong> Client grants the Provider a non-exclusive, worldwide, royalty-free license to use, reproduce, modify, display, and distribute any Client data and AI-generated outputs as necessary to perform the services under this Agreement and to improve Provider's AI technologies and services, subject to the confidentiality obligations of this Agreement.</p>
<p><strong>Intellectual Property Indemnification.</strong> Provider agrees to indemnify Client against any claims, damages, losses, and expenses arising from a breach of intellectual property rights related to the Services provided, except where such claims arise from Client's data or use of AI-generated outputs beyond the scope of this Agreement. Client agrees to indemnify the Provider against any claims, damages, losses, and expenses arising from Client's use of AI-generated outputs in violation of third-party intellectual property rights.</p>
<h2>Data Rights and Ownership</h2>
<p>For purposes of this Service Attachment, <strong>"AI Data"</strong> shall include all data, information, and material provided by Client to Provider for the purpose of receiving AI Services (<strong>"Client AI Data"</strong>), as well as all data, content, and materials generated by the AI Services as a result of processing Client AI Data or through interactions with Client's systems (<strong>"AI-Generated Data"</strong>).</p>
<p><strong>Ownership of Client AI Data.</strong> Client retains all right, title, and interest in and to Client AI Data. Provider acknowledges that it has no ownership rights over Client AI Data. Client grants the Provider a non-exclusive, worldwide, royalty-free license to access, use, process, and display Client AI Data solely for the purpose of performing the AI Services under this Service Attachment.</p>
<p><strong>Ownership of AI-Generated Data.</strong> AI-Generated Data shall be owned by Client, subject to any underlying rights of third parties in the data or content from which such AI-Generated Data is derived. Client grants to Provider a non-exclusive, royalty-free right to use AI-Generated Data for the purposes of improving Provider's AI Services, conducting research and development, and enhancing the AI models, subject to the confidentiality obligations and data protection provisions of this Agreement.</p>
<p><strong>Data Usage Rights.</strong> Client grants to Provider the right to use aggregated and anonymized data derived from Client AI Data and AI-Generated Data for analytics, benchmarking, and to improve Provider's services, provided such use does not reveal the identity of Client, any of its employees, clients, or Clients. Provider acknowledges that it shall not sell, lease, or otherwise provide access to Client AI Data or AI-Generated Data to any third party, except as permitted by this Agreement or with Client's prior written consent.</p>
<p><strong>Return and Deletion of Data.</strong> Upon termination or expiration of this Service Attachment, Provider shall, at Client's option, return all Client AI Data and AI-Generated Data to Client or securely destroy such data, and certify to Client that it has done so, unless required to retain the data by law.</p>
<h2>Exclusions</h2>
<p>Provider is not responsible for failures to provide Services that are caused by the existence of any of the following conditions:</p>
<ul>
  <li><strong>Third-Party Services and Products</strong> — Provider is not responsible for issues resulting from third-party services or products not directly supplied or controlled by Provider.</li>
  <li><strong>Client's Failure to Follow Recommendations</strong> — Failures or performance issues resulting from Client's disregard for Provider's recommendations or instructions.</li>
  <li><strong>Unauthorized Modifications</strong> — Problems stemming from unauthorized alterations to the service or system by Client or third parties.</li>
  <li><strong>Force Majeure</strong> — Delays or failures in performance caused by events beyond its reasonable control, including natural disasters, government actions, or terrorism.</li>
  <li><strong>Pre-existing Conditions</strong> — Issues pre-dating the Agreement or unrelated to the provided services are excluded from Provider's responsibilities.</li>
  <li><strong>Compliance with Laws</strong> — Ensuring compliance with all applicable laws and regulations remains Client's obligation, excluding the Provider from related liabilities.</li>
  <li><strong>Unauthorized Access or Security Breaches</strong> — Unauthorized access or breaches.</li>
  <li><strong>Bias and Fairness</strong> — Outcomes influenced by biases inherent in AI models or data are excluded from Provider's liabilities.</li>
  <li><strong>AI Hallucinations</strong> — Inaccuracies or fabrications ("hallucinations") produced by AI models.</li>
  <li><strong>Model Interpretability</strong> — Lack of detailed explanations for AI model decisions due to the "black box" nature of some AI technologies.</li>
  <li><strong>Unpredictable AI Behavior</strong> — Unforeseen or unpredictable AI system behaviors that result in unintended outcomes.</li>
  <li><strong>Data-Driven Limitations</strong> — Limitations arising from inadequate or poor-quality data supplied by Client or inherent in used datasets.</li>
  <li><strong>Ethical Use and Compliance</strong> — Client is solely responsible for ensuring the ethical use and legal compliance of AI-driven outputs.</li>
  <li><strong>Continuous Learning Changes</strong> — Changes in AI behavior due to continuous learning processes, not directly managed by the Provider.</li>
  <li><strong>Intellectual Property Claims from AI Outputs</strong> — Claims of intellectual property infringement arising from AI-generated content or outputs.</li>
  <li><strong>Disruption of Data Sources</strong> — Any interruption or cessation of access to essential data sources or third-party services required for the operation of AI services due to reasons outside of Provider's control, including but not limited to, discontinuation of services, changes in terms of service, or access restrictions imposed by data providers.</li>
  <li><strong>AI Model Failure</strong> — Any sudden failure, degradation, or unpredicted behavior of AI models that significantly impacts service delivery, where such issues cannot be promptly resolved through reasonable efforts due to the complex and "black box" nature of certain AI technologies.</li>
  <li><strong>Regulatory or Legal Changes</strong> — Any changes in laws, regulations, or government policies that directly prohibit, restrict, or impose additional burdens on the deployment, operation, or use of AI technologies and services contemplated by this Agreement.</li>
  <li><strong>Infrastructure Failures</strong> — Failures in critical infrastructure supporting AI services, including cloud computing platforms, data storage systems, and networking services, caused by external factors such as cyberattacks, service provider outages, or natural disasters.</li>
</ul>
<h2>Disclaimer of Warranties</h2>
<p><strong>As-Is.</strong> Provider furnishes all AI-driven services, including but not limited to AI models, algorithms, software, and any AI-generated content or data, on an "as is" and "as available" basis. Provider expressly disclaims all warranties, whether express, implied, statutory, or otherwise, including but not limited to implied warranties of merchantability, fitness for a particular purpose, non-infringement, and any warranties arising out of the course of dealing or usage of trade.</p>
<p><strong>No Guarantee of Results.</strong> Provider makes no warranty that the AI services will meet Client's requirements or achieve any intended results. Due to the experimental nature of AI technologies, the performance of AI services can be unpredictable, and Client acknowledges that the services are provided without any guarantee of accuracy, completeness, or reliability of AI-generated outputs.</p>
<p><strong>Third-Party Components.</strong> Provider disclaims any warranty related to third-party components, data, or materials used in conjunction with the AI services, including any warranty of accuracy, reliability, or effectiveness of such third-party components.</p>
<p><strong>No Warranty of Uninterrupted Use.</strong> Provider does not warrant that the provision of AI services will be uninterrupted, timely, secure, or error-free; nor does it make any warranty as to the results that may be obtained from the use of the AI services.</p>
<p><strong>Client Responsibility.</strong> Client acknowledges that it assumes full responsibility for the selection of the AI services to achieve its intended results and for the use and results obtained from the AI services. Client further acknowledges that it must regularly review and validate AI-generated outputs for accuracy and appropriateness for the intended use.</p>
<h2>Term and Termination</h2>
<p><strong>Term.</strong> This Service Attachment is effective on the date specified on the Order (the "Service Start Date"). Unless properly terminated by either party, this Attachment will remain in effect through the end of the term specified on the Order (the "Initial Term").</p>
<p><strong>Renewal.</strong> "Renewal" means the extension of any Initial Term specified on an Order for an additional twelve (12) month period following the expiration of the Initial Term, or in the case of a subsequent renewal, a Renewal Term. This Service Attachment will renew automatically upon the expiration of the Initial Term or a Renewal Term unless one party provides written notice to the other party of its intent to terminate at least sixty (60) days prior to the expiration of the Initial Term or of the then-current Renewal Term. All renewals will be subject to Provider's then-current terms and conditions.</p>
<p><strong>Month-to-Month Services.</strong> If the Order specifies no Initial Term with respect to any or all Services, then we will deliver those Services on a month-to-month basis. We will continue to do so until one party provides written notice to the other party of its intent to terminate those Services, in which case we will cease delivering those Services at the end of the next calendar month following receipt such written notice is received by the other party.</p>
<p><strong>Early Termination by Client With Cause.</strong> Client may terminate this Service Attachment for cause following sixty (60) days' advance, written notice delivered to Provider upon the occurrence of any of the following:</p>
<ul>
  <li>Provider fails to fulfill in any material respect its obligations under the Service Attachment and fails to cure such failure within thirty (30) days following Provider's receipt of Client's written notice.</li>
  <li>Provider terminates or suspends its business operations (unless succeeded by a permitted assignee under the Agreement).</li>
</ul>
<p><strong>Early Termination by Client Without Cause.</strong> If Client has satisfied all of its obligations under this Service Attachment, then no sooner than ninety (90) days following the Service Start Date, Client may terminate this Service Attachment without cause during the Initial or a Renewal Term (the "Term") upon sixty (60) days' advance, written notice, provided that Client pays Provider a termination fee equal to fifty percent (50%) of the recurring, Monthly Service Fees remaining to be paid from the effective termination date through the end of the Term, based on the prices then in effect.</p>
<p><strong>Termination by Provider.</strong> Provider may elect to terminate this Service Attachment upon thirty (30) days' advance, written notice, with or without cause. Provider has the right to terminate this Service Attachment immediately for illegal or abusive Client conduct. Provider may suspend the Services upon ten (10) days' notice if Client violates a third-party's end user license agreement regarding provided software. Provider may suspend the Services upon fifteen (15) days' notice if Client's action or inaction hinder Provider from providing the contracted Services.</p>
<p><strong>Effect of Termination.</strong> As long as Client is current with payment of: (i) the Fees under this Attachment, (ii) the Fees under any Project Services Attachment or Statement of Work for Off-Boarding, and/or (iii) the Termination Fee prior to transitioning the Services away from Provider's control, then if either party terminates this Service Attachment, Provider will assist Client in the orderly termination of services, including timely transfer of the Services to another designated provider. Client shall pay Provider at our then-prevailing rates for any such assistance. Termination of this Service Attachment for any reason by either party immediately nullifies all access to our services. Provider will immediately uninstall any affected software from Client's devices, and Client hereby consents to such uninstall procedures.</p>
<p>Upon request by Client, Provider may provide Client a copy of Client Data in exchange for a data-copy fee invoiced at Provider's then-prevailing rates, not including the cost of any media used to store the data. After thirty (30) days following termination of this Agreement by either party for any reason, Provider shall have no obligation to maintain or provide any Client Data and shall thereafter, unless legally prohibited, delete all Client Data on its systems or otherwise in its possession or under its control.</p>
<p>Provider may audit Client regarding any third-party services. Provider may increase any Fees for Off-boarding that are passed to the Provider for those third-party services Client used or purchased while using the Service. Client agrees that upon Termination or Off-Boarding, Client shall pay all remaining third-party service fees and any additional third-party termination fees.</p>
<h2>Continuing acceptance</h2>
<p>By using the AI Services, you accept this policy. Material changes will be published here and at the <a href="https://docs.ourterms.live/WYRE/AI-Attachment.pdf">canonical PDF</a>. Your continued use after a material change constitutes acceptance of the revised policy. Per-user point-in-time consent — captured at signup with a click-to-accept and stored with a content hash — is recorded separately and is not a substitute for the continuing-acceptance language in this paragraph.</p>
<h2>Contact</h2>
<p>Questions about this policy or about how WYRE handles AI Services should reach <strong><a href="mailto:hello@wyre.ai">hello@wyre.ai</a></strong>.</p>
<p style="font-size:13px; color:var(--text-muted); margin-top:24px;">This Service Attachment template was authored by Scott & Scott, LLP; WYRE Technology has adopted it as the policy text for its AI Services. The canonical PDF is maintained at <a href="https://docs.ourterms.live/WYRE/AI-Attachment.pdf">docs.ourterms.live/WYRE/AI-Attachment.pdf</a>.</p>
`;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function legalRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/terms', async (_request, reply) => {
      return reply.type('text/html').send(legalPage('Terms of Service', TERMS_CONTENT));
    });

    app.get('/privacy', async (_request, reply) => {
      return reply.type('text/html').send(legalPage('Privacy Policy', PRIVACY_CONTENT));
    });

    app.get('/msa', async (_request, reply) => {
      return reply.type('text/html').send(legalPage('AI Services — Service Attachment', MSA_CONTENT));
    });
  };
}
