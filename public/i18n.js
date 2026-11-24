(()=>{'use strict';
const dictionary={
'BARBERPRO WORKSPACE':'BARBERPRO कार्यक्षेत्र','Sign in to open your role-based workspace.':'तुमच्या भूमिकेनुसार डॅशबोर्ड उघडण्यासाठी साइन इन करा.',
'Sign in':'साइन इन','Create customer account':'ग्राहक खाते तयार करा','Continue':'पुढे जा','Find your next cut.':'तुमची पुढील हेअरकट सेवा शोधा.',
'Discover shops, choose a barber and book a time.':'दुकान शोधा, न्हावी निवडा आणि वेळ बुक करा.',
'Book an appointment':'अपॉइंटमेंट बुक करा','Shop':'दुकान','Service':'सेवा','Date':'दिनांक','Barber / available slot':'न्हावी / उपलब्ध वेळ',
'Book appointment':'अपॉइंटमेंट बुक करा','Your bookings':'तुमच्या बुकिंग्स','Payment history':'पेमेंट इतिहास',
'Your chair, in control.':'तुमचे काम, तुमच्या नियंत्रणात.','Daily appointments, client details and service status.':'दैनंदिन अपॉइंटमेंट्स, ग्राहक तपशील आणि सेवेची स्थिती.',
'Work date':'कामाचा दिनांक','My working hours & days off':'माझे कामाचे तास आणि सुट्टीचे दिवस','Working day':'कामाचा दिवस','Opens':'सुरू','Closes':'बंद',
'My breaks':'माझे ब्रेक','Add break':'ब्रेक जोडा','Save weekly schedule':'साप्ताहिक वेळापत्रक जतन करा',
'Appointment booked. Payment will be available after the barber completes the service.':'अपॉइंटमेंट बुक झाली. न्हावी सेवा पूर्ण केल्यानंतर पेमेंट उपलब्ध होईल.',
'No appointments yet.':'अजून अपॉइंटमेंट्स नाहीत.','No available slots':'वेळ उपलब्ध नाही','Cancel':'रद्द करा','Confirm':'पुष्टी करा','Complete':'पूर्ण करा',
'No-show':'उपस्थित नाही','Customer':'ग्राहक','Email':'ईमेल','Password':'पासवर्ड','Payment captured successfully.':'पेमेंट यशस्वी झाले.',
'The AI receptionist is not configured yet.':'AI सहाय्यक अद्याप कॉन्फिगर केलेला नाही.'
};
const key='bp_locale';let locale=localStorage.getItem(key)||'en';
function translate(root=document.body){if(locale!=='mr')return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);for(const n of nodes){const v=n.nodeValue.trim();if(dictionary[v])n.nodeValue=n.nodeValue.replace(v,dictionary[v])}}
function apply(){document.documentElement.lang=locale==='mr'?'mr':'en';translate();const old=document.getElementById('bp-language-toggle');if(old)old.remove();const b=document.createElement('button');b.id='bp-language-toggle';b.type='button';b.textContent=locale==='mr'?'English':'मराठी';b.setAttribute('aria-label','Change language');b.style.cssText='position:fixed;right:16px;bottom:16px;z-index:9999;padding:10px 14px;border-radius:24px;border:1px solid #9dbb8c;background:#203126;color:#fff;font-weight:700;box-shadow:0 4px 18px #0005';b.onclick=()=>{locale=locale==='mr'?'en':'mr';localStorage.setItem(key,locale);location.reload()};document.body.appendChild(b)}
new MutationObserver(()=>translate()).observe(document.documentElement,{childList:true,subtree:true});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply);else apply();
})();
