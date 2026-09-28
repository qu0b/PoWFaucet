import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { SessionManager } from "../../session/SessionManager.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IRecurringLimitConfig, IRecurringLimitsConfig } from './RecurringLimitsConfig.js';
import { FaucetError } from '../../common/FaucetError.js';
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { renderTimespan } from "../../utils/DateUtils.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import type { EthClaimInfo } from "../../eth/EthClaimManager.js";

export class RecurringLimitsModule extends BaseModule<IRecurringLimitsConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;

  protected override startModule(): Promise<void> {
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 7, "Recurring limits check", 
      (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 6, "recurring limits factor", 
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionClaim, 6, "recurring payout limit",
      (claim: EthClaimInfo) => this.processSessionClaim(claim)
    );
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    return Promise.resolve();
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    await Promise.all(this.moduleConfig.limits.map((limit) => this.checkLimit(session, limit)));
  }

  private async checkLimit(session: FaucetSession, limit: IRecurringLimitConfig): Promise<void> {
    let finishedSessions = await this.getFinishedSessions(session.getTargetAddr(), session.getRemoteIP(), limit);
    let limitApplies = false;
    if(limit.limitCount > 0 && finishedSessions.length >= limit.limitCount) {
      limitApplies = true;
      if(!limit.action || limit.action == "block") {
        let errMsg = limit.message || [
          "You have already created ",
          finishedSessions.length,
          (finishedSessions.length > 1 ? " sessions" : " session"), 
          " in the last ",
          renderTimespan(limit.duration)
        ].join("");
        throw new FaucetError(
          "RECURRING_LIMIT", 
          errMsg,
        );
        }
    }
    if(limit.limitAmount > 0) {
      let totalAmount = 0n;
      finishedSessions.forEach((session) => totalAmount += BigInt(session.dropAmount));
      if(totalAmount >= BigInt(limit.limitAmount)) {
        limitApplies = true;
        if(!limit.action || limit.action == "block") {
          let errMsg = limit.message || [
            "You have already requested ",
            ServiceManager.GetService(EthWalletManager).readableAmount(totalAmount),
            " in the last ",
            renderTimespan(limit.duration)
          ].join("");
          throw new FaucetError(
            "RECURRING_LIMIT", 
            errMsg,
          );
        }
      }
    }

    if(limitApplies && typeof limit.rewards !== "undefined") {
      let cfactor = session.getSessionData("recurring-limits.factor");
      if(typeof cfactor === "undefined" || limit.rewards < cfactor)
        session.setSessionData("recurring-limits.factor", limit.rewards);
    }
  }

  private async getFinishedSessions(targetAddr: string, remoteIp: string, limit: IRecurringLimitConfig): Promise<FaucetSessionStoreData[]> {
    if(limit.ip4Subnet && remoteIp.match(/^[0-9.]+$/)) {
      let ipParts = remoteIp.split(".").slice(0, limit.ip4Subnet / 8);
      if(ipParts.length < 4) {
        ipParts.push("%");
        remoteIp = ipParts.join(".");
      }
    }

    if(limit.byAddrOnly)
      return await ServiceManager.GetService(FaucetDatabase).getFinishedSessions(targetAddr, null, limit.duration, true);
    if(limit.byIPOnly)
      return await ServiceManager.GetService(FaucetDatabase).getFinishedSessions(null, remoteIp, limit.duration, true);
    return await ServiceManager.GetService(FaucetDatabase).getFinishedSessions(targetAddr, remoteIp, limit.duration, true);
  }

  private async processSessionClaim(claim: EthClaimInfo): Promise<void> {
    let session = await ServiceManager.GetService(SessionManager).getSessionData(claim.session);
    if(!session || (session.data?.["skip.modules"] || []).indexOf(this.moduleName) !== -1)
      return;

    for(const limit of this.moduleConfig.limits) {
      if(!limit.limitAmount || limit.limitAmount <= 0 || (limit.action && limit.action !== "block"))
        continue;
      let finished = (await this.getFinishedSessions(session.targetAddr, session.remoteIP, limit))
        .filter((item) => item.sessionId !== claim.session);
      let total = finished.reduce((sum, item) => sum + BigInt(item.dropAmount), 0n);
      if(total + BigInt(claim.amount) > BigInt(limit.limitAmount))
        throw new FaucetError("RECURRING_LIMIT", "Claim would exceed the recurring payout limit");
    }
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]) {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let rewardPerc = session.getSessionData("recurring-limits.factor", 100);
    if(rewardPerc !== 100) {
      rewardFactors.push({
        factor: rewardPerc / 100,
        module: this.moduleName,
      });
    }
  }

}
