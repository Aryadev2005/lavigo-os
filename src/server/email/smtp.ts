/**
 * Email adapter (SMTP via nodemailer). Dev: SMTP_URL points at Mailpit (http://localhost:8025);
 * empty SMTP_URL outside production → the fake, which only logs. Never logs addresses or bodies.
 */
import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env";
import { logger } from "../logger";

export type Mail = { to: string; subject: string; text: string; replyTo?: string };
export type MailReceipt = { messageId: string };

export interface Mailer {
  send(mail: Mail): Promise<MailReceipt>;
}

class SmtpMailer implements Mailer {
  private transport: Transporter;
  constructor(url: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: Mail): Promise<MailReceipt> {
    const info = await this.transport.sendMail({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text, replyTo: mail.replyTo });
    return { messageId: String(info.messageId) };
  }
}

class FakeMailer implements Mailer {
  async send(mail: Mail): Promise<MailReceipt> {
    const messageId = `fake.mail.${randomUUID()}`;
    logger.info({ messageId, subjectLength: mail.subject.length }, "email (fake) send");
    return { messageId };
  }
}

let mailer: Mailer | undefined;

export function getMailer(): Mailer {
  mailer ??= env.providers.smtp === "real" && env.SMTP_URL ? new SmtpMailer(env.SMTP_URL) : new FakeMailer();
  return mailer;
}

export function sendMail(mail: Mail): Promise<MailReceipt> {
  return getMailer().send(mail);
}
