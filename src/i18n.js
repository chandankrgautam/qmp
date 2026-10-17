/**
 * Interface language.
 *
 * English is primary, Hindi secondary, and the choice persists per device.
 * Category names, notification text and the excluded-scope notice already
 * carry both languages in the database; this covers the interface chrome
 * that does not.
 *
 * A missing Hindi string falls back to English rather than showing a key,
 * so an untranslated addition degrades quietly instead of breaking a
 * screen for the residents who most need the Hindi.
 */
const STR = {
  // chrome
  app_name:        ['Colony Maintenance', 'कॉलोनी अनुरक्षण'],
  switch_user:     ['Switch user', 'उपयोगकर्ता बदलें'],
  language_toggle: ['हिन्दी', 'English'],
  back:            ['Back', 'वापस'],
  nothing_yet:     ['Nothing here yet.', 'अभी कुछ नहीं।'],
  not_found:       ['Not found.', 'नहीं मिला।'],
  new_badge:       ['new', 'नए'],

  // sign in and registration
  who_are_you:     ['Who are you?', 'आप कौन हैं?'],
  device_is_key:   ['Each of these is a registered device. On a handset the app would already be signed in — the device itself is the credential, so there is no password to remember.',
                    'इनमें से हर एक पंजीकृत डिवाइस है। मोबाइल पर ऐप पहले से खुला रहेगा — डिवाइस ही आपकी पहचान है, कोई पासवर्ड याद रखने की जरूरत नहीं।'],
  new_here:        ['New here?', 'पहली बार आए हैं?'],
  register_device: ['Register this device', 'यह डिवाइस पंजीकृत करें'],
  register_intro:  ['There is no password. Once the Civil Maintenance Incharge checks your details, this device becomes your way into the portal.',
                    'कोई पासवर्ड नहीं है। सिविल अनुरक्षण प्रभारी आपके विवरण की जाँच कर लें, उसके बाद यही डिवाइस पोर्टल में आपका प्रवेश बन जाएगा।'],
  your_name:       ['Your name', 'आपका नाम'],
  personnel_no:    ['Personnel number', 'कार्मिक संख्या'],
  mobile:          ['Mobile', 'मोबाइल'],
  colony:          ['Colony', 'कॉलोनी'],
  sector:          ['Sector', 'सेक्टर'],
  no_sector:       ['This colony has no sectors', 'इस कॉलोनी में सेक्टर नहीं हैं'],
  blank_if_none:   ['Leave blank if none', 'न हो तो खाली छोड़ें'],
  quarter_number:  ['Quarter number', 'क्वार्टर संख्या'],
  as_written:      ['As written on your quarter', 'जैसा आपके क्वार्टर पर लिखा है'],
  write_as_seen:   ['Write it as you see it. The Incharge will correct the format if needed.',
                    'जैसा दिखे वैसा लिखें। आवश्यक हुआ तो प्रभारी सही कर देंगे।'],
  send_for_check:  ['Send for checking', 'जाँच हेतु भेजें'],
  sent_for_check:  ['Sent for checking', 'जाँच हेतु भेजा गया'],
  registering_as:  ['Registering as', 'किस रूप में पंजीकरण'],
  send_code:       ['Send me a code', 'मुझे कोड भेजें'],
  code_sent:       ['A code has been sent to your mobile. Enter it to finish.',
                    'आपके मोबाइल पर कोड भेजा गया है। पूरा करने के लिए उसे दर्ज करें।'],
  otp_code:        ['Code', 'कोड'],
  dev_code_note:   ['Development only — no SMS gateway yet. The code is',
                    'केवल विकास हेतु — अभी एसएमएस व्यवस्था नहीं है। कोड है'],
  verify_and_send: ['Verify and send for checking', 'सत्यापित कर जाँच हेतु भेजें'],

  // complaints
  report_problem:  ['Report a problem', 'शिकायत दर्ज करें'],
  your_complaints: ['Your complaints', 'आपकी शिकायतें'],
  all_complaints:  ['All complaints', 'सभी शिकायतें'],
  what_is_wrong:   ['What is wrong', 'क्या समस्या है'],
  anything_else:   ['Anything else we should know (optional)', 'और कुछ बताना चाहें (वैकल्पिक)'],
  quarter_prefilled: ['Your quarter is filled in from your registered device.',
                      'आपका क्वार्टर आपके पंजीकृत डिवाइस से भरा गया है।'],
  starred_emergency: ['Items marked * can be reported as emergencies.',
                      '* वाली समस्याएँ आपातकालीन रूप से दर्ज की जा सकती हैं।'],
  report_emergency: ['Report as an emergency', 'आपातकालीन के रूप में दर्ज करें'],
  emergency_warning: ['Only certain problems can be emergencies. Misuse is recorded.',
                      'केवल कुछ समस्याएँ आपातकालीन हो सकती हैं। दुरुपयोग दर्ज किया जाता है।'],
  send_complaint:  ['Send complaint', 'शिकायत भेजें'],
  emergency:       ['Emergency', 'आपातकालीन'],
  past_sla:        ['Past SLA', 'समय सीमा पार'],
  due:             ['Due', 'नियत'],
  workmen:         ['Workmen', 'कारीगर'],
  photos_on_file:  ['photograph(s) on file', 'फोटो दर्ज'],
  history:         ['History', 'विवरण'],
  no_action:       ['No action available to you.', 'आपके लिए कोई कार्रवाई उपलब्ध नहीं।'],
  not_permitted:   ['Not permitted', 'अनुमति नहीं'],

  // objections
  something_wrong: ['Something wrong with the work?', 'कार्य में कोई कमी है?'],
  objection_ph:    ['What is wrong with the work being done', 'हो रहे कार्य में क्या कमी है'],
  tell_overseer:   ['Tell the Overseer', 'पर्यवेक्षक को बताएँ'],
  contractor_not_shown: ['The contractor is not shown this.', 'ठेकेदार को यह नहीं दिखाया जाता।'],
  objection_raised: ['Objection raised while work was under way', 'कार्य के दौरान दर्ज आपत्ति'],
  answered:        ['Answered', 'उत्तर दिया गया'],
  not_answered:    ['Not yet answered', 'अभी उत्तर नहीं'],

  // inspection and queues
  to_inspect:      ['To inspect', 'निरीक्षण करना है'],
  oldest_waiting:  ['Oldest waiting', 'सबसे पुराना लंबित'],
  hours:           ['hours', 'घंटे'],
  escalates_at_48: ['Escalates to the Incharge at 48 hours', '48 घंटे पर प्रभारी को भेजा जाएगा'],
  waiting:         ['waiting', 'लंबित'],
  inspection_photo_note: ['Inspecting records a photograph with your location.',
                          'निरीक्षण के साथ आपकी लोकेशन सहित फोटो दर्ज होगी।'],
  inspection_priority: ['Inspection priority', 'निरीक्षण प्राथमिकता'],
  soonest:         ['1 = soonest', '1 = सबसे पहले'],
  why:             ['Why', 'कारण'],
  set_priority:    ['Set priority', 'प्राथमिकता तय करें'],
  select_all:      ['Select all', 'सभी चुनें'],
  inspect_selected: ['Accept selected', 'चयनित स्वीकार करें'],
  batch_note:      ['One visit, several quarters. Each still records its own photograph.',
                    'एक दौरा, कई क्वार्टर। हर एक की अपनी फोटो दर्ज होगी।'],

  // assignment
  registrations:   ['Registrations', 'पंजीकरण'],
  registrations_waiting: ['Registrations waiting', 'लंबित पंजीकरण'],
  correction_note: ['Correcting the quarter number here is how the premises register gets built. Write it in the department\'s format.',
                    'यहाँ क्वार्टर संख्या सुधारना ही वह तरीका है जिससे परिसर रजिस्टर बनता है। विभाग के प्रारूप में लिखें।'],
  correct_number:  ['Correct the quarter number', 'क्वार्टर संख्या सुधारें'],
  quarter_type:    ['Quarter type', 'क्वार्टर प्रकार'],
  approve:         ['Approve', 'स्वीकृत करें'],
  reject:          ['Reject', 'अस्वीकार करें'],
  reason_reject:   ['Reason for rejection', 'अस्वीकृति का कारण'],
  already_claimed: ['Quarter already claimed', 'क्वार्टर पहले से दर्ज'],
  nothing_waiting: ['Nothing waiting.', 'कुछ लंबित नहीं।'],
  assign_queue:    ['Waiting to be given out', 'सौंपना बाकी'],
  assign_selected: ['Give selected to contractor', 'चयनित ठेकेदार को सौंपें'],
  open_jobs:       ['open jobs', 'लंबित कार्य'],
  bulk_note:       ['Several complaints in one block go to one contractor in a single action.',
                    'एक ही ब्लॉक की कई शिकायतें एक बार में एक ठेकेदार को दी जा सकती हैं।'],

  // notifications
  notifications:   ['Notifications', 'सूचनाएँ'],
  mark_all_read:   ['Mark all read', 'सभी पढ़ा हुआ चिह्नित करें'],

  // excluded scope
  not_handled:     ['Not handled in this portal at present',
                    'इस पोर्टल में अभी उपलब्ध नहीं'],
  not_handled_intro: ['This portal handles maintenance of individual premises — your quarter, or the building in your charge. The following are not covered here.',
                      'यह पोर्टल केवल व्यक्तिगत परिसर — आपके क्वार्टर या आपके प्रभार के भवन — का अनुरक्षण देखता है। निम्नलिखित यहाँ शामिल नहीं हैं।'],
  your_area_office: ['Your Area Civil Maintenance Office',
                     'आपका क्षेत्रीय सिविल अनुरक्षण कार्यालय'],
  future_phases:   ['These services will be added to this portal in future phases.',
                    'ये सेवाएँ आगे के चरणों में इस पोर्टल में जोड़ी जाएँगी।'],
  what_not_handled: ['What is not handled here', 'यहाँ क्या शामिल नहीं है'],

  // admin
  administration:  ['Administration', 'प्रशासन'],
  settings:        ['Settings', 'सेटिंग्स'],
  sla_rules:       ['SLA by complaint type', 'शिकायत प्रकार अनुसार समय सीमा'],
  dashboard_cards: ['Dashboard cards', 'डैशबोर्ड कार्ड'],
  response_min:    ['Response (min)', 'प्रतिक्रिया (मिनट)'],
  completion_min:  ['Completion (min)', 'पूर्णता (मिनट)'],
  save:            ['Save', 'सहेजें'],
  saved:           ['Saved', 'सहेजा गया'],
  value:           ['Value', 'मान'],
  warn_above:      ['Warn above', 'चेतावनी इससे ऊपर'],
  critical_above:  ['Critical above', 'गंभीर इससे ऊपर'],
  shown:           ['Shown', 'दिखाएँ'],
  contracts:       ['Contracts', 'संविदाएँ'],
  contract_perf:   ['Contract performance', 'संविदा निष्पादन'],
  contractor:      ['Contractor', 'ठेकेदार'],
  agreement_no:    ['Agreement number', 'करार संख्या'],
  expires:         ['Expires', 'समाप्ति'],
  days_left:       ['days left', 'दिन शेष'],
  within_sla:      ['Within SLA', 'समय सीमा के भीतर'],
  sent_back:       ['Sent back', 'वापस भेजे'],
  reopened_pct:    ['Reopened', 'पुनः खोले'],
  rating:          ['Rating', 'रेटिंग'],
  tickets:         ['Complaints', 'शिकायतें'],
  export_csv:      ['Export as CSV', 'CSV में निर्यात'],
  handover:        ['Hand over', 'हस्तांतरण'],
  handed_over:     ['Handed over', 'हस्तांतरित'],
  delay_by:        ['Delay attributed to', 'विलंब का कारण'],
  repeat_faults:   ['Premises with repeat complaints', 'बार-बार शिकायत वाले परिसर'],
  evidence_note:   ['Evidence only. Penalty and liquidated damages decisions rest with the department.',
                    'केवल साक्ष्य। दंड एवं परिनिर्धारित क्षति का निर्णय विभाग का है।'],
  weakest_first:   ['Weakest first', 'सबसे कमजोर पहले'],
  admin_note:      ['Changes here take effect immediately, for every officer, with no release.',
                    'यहाँ किए गए बदलाव तुरंत, सभी अधिकारियों के लिए, बिना किसी रिलीज़ के लागू होते हैं।']
};

const STATE = {
  RAISED:                  ['Waiting to be checked', 'जाँच बाकी'],
  VERIFIED:                ['Checked, waiting for the contractor', 'जाँची गई, ठेकेदार की प्रतीक्षा'],
  ASSIGNED:                ['Given to the contractor', 'ठेकेदार को सौंपी गई'],
  IN_PROGRESS:             ['Work under way', 'कार्य जारी'],
  WORK_COMPLETED:          ['Contractor says done, waiting for inspection', 'ठेकेदार ने पूर्ण बताया, निरीक्षण बाकी'],
  INSPECTED_ACCEPTED:      ['Inspected and accepted', 'निरीक्षण कर स्वीकृत'],
  CLOSED:                  ['Closed', 'बंद'],
  REJECTED:                ['Not accepted', 'स्वीकार नहीं'],
  REWORK:                  ['Sent back for rework', 'पुनः कार्य हेतु वापस'],
  REFERRED_SPECIAL_REPAIR: ['Referred for special repair', 'विशेष मरम्मत हेतु भेजी'],
  REOPENED:                ['Reopened', 'पुनः खोली गई']
};

const ACTION = {
  verify:  ['Check and accept', 'जाँचकर स्वीकार करें'],
  reject:  ['Reject', 'अस्वीकार करें'],
  assign:  ['Give to contractor', 'ठेकेदार को सौंपें'],
  start:   ['Start work', 'कार्य शुरू करें'],
  complete: ['Mark work done', 'कार्य पूर्ण चिह्नित करें'],
  inspect: ['Inspect and accept', 'निरीक्षण कर स्वीकार करें'],
  close:   ['Close', 'बंद करें'],
  reopen:  ['Still not fixed', 'अब भी ठीक नहीं'],
  'send-back': ['Send back', 'वापस भेजें'],
  'refer-special-repair': ['Refer for special repair', 'विशेष मरम्मत हेतु भेजें']
};

const ROLE = {
  RESIDENT:              ['resident', 'निवासी'],
  CUSTODIAN:             ['custodian', 'प्रभारी'],
  CONTRACTOR_SUPERVISOR: ['contractor supervisor', 'ठेकेदार पर्यवेक्षक'],
  CIVIL_OVERSEER:        ['civil overseer', 'सिविल पर्यवेक्षक'],
  MAINTENANCE_INCHARGE:  ['maintenance incharge', 'अनुरक्षण प्रभारी'],
  STAFF_OFFICER_CIVIL:   ['staff officer (civil)', 'स्टाफ अधिकारी (सिविल)'],
  GM_CIVIL:              ['GM (civil)', 'महाप्रबंधक (सिविल)'],
  ADMINISTRATOR:         ['administrator', 'प्रशासक']
};

const idx = (lang) => (lang === 'hi' ? 1 : 0);
const from = (table, key, lang) => {
  const e = table[key];
  if (!e) return key;
  return e[idx(lang)] || e[0];      // fall back to English, never to a key
};

export const t       = (key, lang) => from(STR, key, lang);
export const tState  = (key, lang) => from(STATE, key, lang);
export const tAction = (key, lang) => from(ACTION, key, lang);
export const tRole   = (key, lang) => from(ROLE, key, lang);
export const LANGS = ['en', 'hi'];
