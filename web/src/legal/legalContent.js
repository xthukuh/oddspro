export const TERMS_VERSION = '2026-07-19';

export const OPERATOR = {
    name: 'Oddspro',
    email: 'info@oddspro.ke',
    jurisdiction: 'Kenya',
};

export const PRIVACY = {
    slug: 'privacy',
    title: 'Privacy Policy',
    updated: '2026-07-19',
    sections: [
        {
            id: 'who-we-are',
            title: 'Who We Are',
            body: [
                'Oddspro (oddspro.ke) is an informational and analytical website run in Kenya. We collect football fixture, odds and statistics data from public bookmaker sites and other public sources, and we compute statistical tips and predictions for entertainment and research purposes.',
                'Oddspro does not accept wagers, does not hold user funds, and is not a bookmaker or betting intermediary of any kind. This policy explains what personal data we collect when you use the site, why we collect it, and what rights you have over it.',
                'If you have any questions about this policy or how your data is handled, contact us at info@oddspro.ke.',
            ],
        },
        {
            id: 'what-we-collect',
            title: 'What We Collect',
            body: [
                'We collect two broad categories of data: anonymous visitor analytics from everyone who browses the site, and account data from people who choose to register.',
                'Visitor analytics (collected from all visitors, whether or not you have an account):',
                '- An anonymous browser identifier (a random UUID stored in your browser\'s local storage, not linked to your name or phone number)',
                '- Visit session details such as start time, end time and duration',
                '- Your IP address',
                '- Your browser and device information (user-agent), parsed into a general device type, browser and operating system',
                '- Coarse geolocation (country and region only) derived from your IP address using a third-party IP-geolocation lookup',
                '- The page you landed on and, where available, the referring site',
                '- In-app feature-usage events, such as opening the help panel or applying a filter, recorded as short event names only, never free-text content',
                'Account data (collected only if you sign up):',
                '- Your phone number',
                '- A securely hashed version of your 4-digit PIN (we never store or see your PIN in plain text)',
                '- An email address, only if you choose to add one later as a backup verification channel and for account recovery',
                '- Your saved display and view preferences, so they sync across your devices',
                '- The date you accepted these terms and which version of the terms you accepted',
            ],
        },
        {
            id: 'why-we-process',
            title: 'Why We Process Your Data',
            body: [
                'Under the Kenya Data Protection Act, 2019, we must have a lawful basis for every way we use your data. We rely on the following:',
                '- Consent: for sending you optional announcement or marketing SMS messages, and for using your coarse location for aggregate traffic reporting. You can withdraw this consent at any time.',
                '- Contract: to create and operate your account, verify your phone number, keep you signed in, and sync your saved preferences across devices, we need to process your phone number, PIN hash and session data.',
                '- Legitimate interest: we process anonymous visitor analytics and feature-usage events to understand how the site is used, detect abuse, and improve reliability and performance, in ways that do not unreasonably affect your privacy.',
                'We do not use your data to make automated decisions that produce legal or similarly significant effects on you.',
            ],
        },
        {
            id: 'sms-and-email',
            title: 'SMS and Email Communications',
            body: [
                'When you register, we send a one-time verification code (OTP) to your phone number by SMS, using Bonga SMS, a Kenyan SMS delivery provider. This transactional message is a required part of creating and securing your account and cannot be opted out of, since it confirms the phone number belongs to you.',
                'If you add an email address later, we may also use it to send a backup one-time code or to help you recover access to your account.',
                'Registered users may also receive occasional announcement or marketing SMS messages, for example about new features. These are optional. You can opt out of announcement messages at any time from your profile settings, without affecting your ability to use the site.',
            ],
        },
        {
            id: 'cookies-and-storage',
            title: 'Cookies and Local Storage',
            body: [
                'Oddspro does not use tracking cookies and does not run any third-party advertising or analytics scripts.',
                'We use your browser\'s local storage and session storage to remember things like your anonymous visitor identifier, your saved view settings, your signed-in session, and your betslip drafts. This data stays on your device and is only sent to our server when needed to load or sync your preferences.',
            ],
        },
        {
            id: 'sharing',
            title: 'Who We Share Data With',
            body: [
                'We do not sell your personal data, and we do not share it with advertisers.',
                'We share limited data with a small number of service providers strictly to operate Oddspro:',
                '- Bonga SMS, to deliver OTP and, where you have opted in, announcement SMS messages to your phone number',
                '- A third-party IP-geolocation service, to resolve visitor IP addresses into a country and region for aggregate traffic reporting',
                '- Our hosting provider, which stores our database and serves the website',
                'These providers only receive the minimum data needed to perform their function and are not permitted to use it for their own purposes.',
                'We may also disclose data if required to do so by Kenyan law or a valid legal request.',
            ],
        },
        {
            id: 'retention',
            title: 'How Long We Keep Your Data',
            body: [
                'We keep visitor analytics and account data for as long as the service operates, or until you ask us to delete it, whichever comes first.',
                'You can request access to, correction of, or deletion of your personal data at any time by emailing info@oddspro.ke. We will respond and act on valid requests within a reasonable time.',
            ],
        },
        {
            id: 'your-rights',
            title: 'Your Rights Under Kenyan Law',
            body: [
                'As a data subject under the Kenya Data Protection Act, 2019, you have the right to:',
                '- Be informed of how your data is used, which this policy sets out',
                '- Access the personal data we hold about you',
                '- Ask us to correct inaccurate or outdated data',
                '- Ask us to delete your personal data, subject to any legal retention requirements',
                '- Object to or restrict certain processing, such as marketing SMS',
                '- Withdraw consent at any time, where processing is based on consent',
                '- Lodge a complaint with the Office of the Data Protection Commissioner of Kenya if you believe your rights have been violated',
                'To exercise any of these rights, email info@oddspro.ke. We may need to verify your identity before acting on a request.',
            ],
        },
        {
            id: 'children',
            title: 'Age Restriction',
            body: [
                'Oddspro is intended only for users aged 18 and over, the legal gambling age in Kenya, because the site discusses betting odds and predictions related to sports wagering offered by third parties.',
                'We do not knowingly collect personal data from anyone under 18. If we become aware that we have done so, we will delete that data promptly.',
            ],
        },
        {
            id: 'changes',
            title: 'Changes to This Policy',
            body: [
                'We may update this Privacy Policy from time to time as the service evolves or as Kenyan data protection law changes. Each version carries an updated date and a terms version identifier.',
                'If we make a material change, we will notify registered users and ask you to review and accept the updated terms before continuing to use account features.',
            ],
        },
        {
            id: 'contact',
            title: 'Contact Us',
            body: [
                'If you have questions, concerns, or requests about this Privacy Policy or your personal data, contact Oddspro at info@oddspro.ke.',
                'Oddspro operates in and is subject to the laws of Kenya.',
            ],
        },
    ],
};

export const TERMS = {
    slug: 'terms',
    title: 'Terms of Use',
    updated: '2026-07-19',
    sections: [
        {
            id: 'acceptance',
            title: 'Acceptance of These Terms',
            body: [
                'These Terms of Use govern your access to and use of Oddspro (oddspro.ke). By browsing the site or creating an account, you agree to these terms.',
                'If you do not agree with any part of these terms, please do not use Oddspro.',
                'We may update these terms from time to time; the version you accepted is recorded against your account, and material changes will prompt you to review and re-accept before continuing to use account features.',
            ],
        },
        {
            id: 'service-description',
            title: 'What Oddspro Is',
            body: [
                'Oddspro is an informational and analytical website only. We aggregate publicly available football odds from bookmaker sites, including BetPawa and Betika, along with fixture, result and statistics data, and we compute statistical tips and predictions from that data.',
                'Oddspro does not accept bets or wagers of any kind, does not hold or handle user funds, and is not a bookmaker, betting exchange, or betting intermediary. We do not place bets on your behalf and have no relationship with your bookmaker account.',
                'Nothing on Oddspro should be understood as an offer to take a bet or as a place to deposit or withdraw money.',
            ],
        },
        {
            id: 'eligibility',
            title: 'Eligibility',
            body: [
                'You must be at least 18 years old, the legal gambling age in Kenya, to use Oddspro. By using the site, you confirm that you meet this requirement.',
                'Oddspro is intended for use in Kenya and by people who understand it is an informational tool, not a betting platform.',
            ],
        },
        {
            id: 'accounts',
            title: 'Accounts',
            body: [
                'To register, you provide a phone number and choose a 4-digit PIN, and verify your phone number by SMS one-time code. You may optionally add an email address later as a backup verification method.',
                'You agree to provide accurate registration information and to keep your phone number and any email address up to date.',
                'You are responsible for keeping your PIN secret and for all activity that happens under your account. If you believe your account has been accessed without your permission, contact us immediately at info@oddspro.ke.',
                'Each person may hold only one Oddspro account. We may suspend or close accounts that appear to be duplicates, fraudulent, or used to circumvent these terms.',
            ],
        },
        {
            id: 'acceptable-use',
            title: 'Acceptable Use',
            body: [
                'When using Oddspro, you agree not to:',
                '- Scrape, crawl, or systematically extract data from the site using automated tools without our written permission',
                '- Attempt to reverse engineer, decompile, or interfere with the site\'s underlying code, models, or infrastructure',
                '- Attempt to gain unauthorized access to any account, system, or data that is not your own',
                '- Use the site for any unlawful purpose, or in a way that violates the rights of others',
                '- Interfere with or disrupt the site\'s availability or performance for other users',
                'We may suspend or terminate access for anyone who violates these rules.',
            ],
        },
        {
            id: 'no-betting-advice',
            title: 'Predictions Are Statistical Estimates, Not Advice',
            body: [
                'Tips, predictions, and any "confidence" figures shown on Oddspro are statistical estimates generated from historical data and modelling. They are provided for informational and entertainment purposes only and do not constitute betting advice, financial advice, or any guarantee of outcome.',
                'Our own historical measurements show that, at real bookmaker prices, our tips carry a negative flat-stake expected value overall, roughly -3%, and we have not identified any betting market that is profitable over time at real odds. Past results, including any displayed hit rates, are not a promise of future performance.',
                'Oddspro never promises or implies that you will win money by following its tips. Any decision to place a bet with a third-party bookmaker is made entirely at your own discretion and risk.',
            ],
        },
        {
            id: 'third-party-bookmakers',
            title: 'Third-Party Bookmakers',
            body: [
                'Oddspro displays odds and may name or link to third-party bookmakers such as BetPawa and Betika for informational purposes. We are not affiliated with, sponsored by, or endorsed by any bookmaker named or linked on the site.',
                'Odds shown on Oddspro are collected from public sources and may be stale, delayed, or incorrect by the time you view them. Always verify current odds, terms, and availability directly with the bookmaker before placing any bet.',
                'We have no control over, and no responsibility for, the products, services, terms, or conduct of any third-party bookmaker.',
            ],
        },
        {
            id: 'responsible-gambling',
            title: 'Responsible Gambling',
            body: [
                'If you choose to bet with a licensed bookmaker, please do so responsibly. Never stake money you cannot afford to lose, and never chase losses.',
                'Gambling involves real financial risk, and no prediction or statistical tip removes that risk. Treat Oddspro\'s content as one input among many, not a certainty.',
                'If you feel that gambling is becoming a problem for you or someone you know, please seek help from a licensed counsellor or a responsible-gambling support service.',
            ],
        },
        {
            id: 'intellectual-property',
            title: 'Intellectual Property',
            body: [
                'The Oddspro name, logo, site design, and the analysis, scoring methods, and presentation of data on the site are the property of Oddspro or its licensors, except for underlying odds and fixture data which originates from third-party public sources.',
                'You may view and use the site for your own personal, non-commercial purposes. You may not copy, redistribute, or build a competing product from Oddspro\'s content or methodology without our written permission.',
            ],
        },
        {
            id: 'disclaimers-and-liability',
            title: 'Disclaimers and Limitation of Liability',
            body: [
                'Oddspro is provided "as is" and "as available", without any warranty of accuracy, completeness, or uninterrupted availability. Data can be delayed, incomplete, or wrong, and predictions can be mistaken.',
                'We may change, suspend, or discontinue any feature of the site at any time, with or without notice.',
                'To the maximum extent permitted by Kenyan law, Oddspro and its operator are not liable for any loss, including betting losses, arising from your use of, or reliance on, information found on the site. Nothing in these terms limits liability that cannot be limited under Kenyan law.',
            ],
        },
        {
            id: 'termination',
            title: 'Termination',
            body: [
                'You may stop using Oddspro at any time and may request deletion of your account and personal data by emailing info@oddspro.ke.',
                'We may suspend or terminate your account if we reasonably believe you have violated these terms, engaged in abusive or unlawful behavior, or if we discontinue the service.',
            ],
        },
        {
            id: 'changes',
            title: 'Changes to These Terms',
            body: [
                'We may revise these Terms of Use from time to time to reflect changes to the service or to applicable Kenyan law. Each version is dated and versioned.',
                'Where a change is material, we will notify registered users and require re-acceptance before you can continue using account features. Continued use of the site after a non-material update constitutes acceptance of the revised terms.',
            ],
        },
        {
            id: 'governing-law',
            title: 'Governing Law',
            body: [
                'These terms are governed by the laws of Kenya. Any dispute arising from your use of Oddspro is subject to the exclusive jurisdiction of the courts of Kenya.',
            ],
        },
        {
            id: 'contact',
            title: 'Contact Us',
            body: [
                'If you have questions about these Terms of Use, contact Oddspro at info@oddspro.ke.',
            ],
        },
    ],
};
