# Estrattore - Downloader di PDF da Gmail (Chrome Extension)

Estensione per Google Chrome che permette di:

- connettersi al proprio account Gmail,
- cercare email contenenti allegati **PDF** (filtrabili con query di ricerca),
- scaricare **tutti i PDF in un unico archivio ZIP**

## Funzionalità principali:

- 🔑 **OAuth2 con Google** (supporto multi-account).
- 📂 Ricerca tramite query Gmail (es. `filename:pdf newer_than:30d`).
- 📦 Download multiplo in **un solo ZIP**.

---

## 🚀 Installazione (da codice sorgente)
1. Clona il repository o scarica lo zip:
   ```bash
   git clone https://github.com/FriedrichBraun/estrattore_pdf_gmail.git
   ```

2. Apri Chrome ed entra in `chrome://extensions/`.

3. Attiva la **Modalità sviluppatore**.

4. Clicca su **Carica estensione non pacchettizzata** e seleziona la cartella del progetto.

5. L’estensione apparirà automaticamente nella toolbar di Chrome.

---

## 🔐 Privacy
- L’estensione utilizza **solo le Gmail API in sola lettura** (`https://www.googleapis.com/auth/gmail.readonly`).
- Nessun dato viene inviato a server esterni: tutto avviene localmente nel browser.
- I token OAuth sono gestiti direttamente da Chrome.

---

## 📜 Licenza
Distribuito sotto licenza **MIT**.  
Vedi il file [LICENSE](LICENSE) per i dettagli.
