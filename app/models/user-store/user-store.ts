import Rate, { AndroidMarket } from "react-native-rate"
import {
  flow,
  Instance,
  SnapshotOut,
  types,
} from "mobx-state-tree"

import { withEnvironment } from "../extensions"
import { UserModel } from "../user"
import { AuthCoreStoreModel } from "../authcore-store"
import { IAPStoreModel } from "../iapStore"

import {
  updateAnalyticsUser,
  logoutAnalyticsUser,
} from '../../utils/analytics'

import {
  GeneralResult,
  UserLoginParams,
  UserResult,
  UserRegisterParams,
} from "../../services/api"

import { throwProblem } from "../../services/api/api-problem"

import { logError } from "../../utils/error"

/**
 * Store user related information.
 */
export const UserStoreModel = types
  .model("UserStore")
  .props({
    currentUser: types.maybe(UserModel),
    authCore: types.optional(AuthCoreStoreModel, {}),
    iapStore: types.optional(IAPStoreModel, {}),
    appRatingPromptedVersions: types.array(types.string),
    appRatingCooldown: types.optional(types.number, 0),
  })
  .volatile(() => ({
    isSigningIn: false,
    isSigningOut: false,
  }))
  .extend(withEnvironment)
  .views(self => ({
    get signInURL() {
      return self.env.likerLandAPI.getSignInURL()
    },
    get crispChatEmbeddedURL() {
      const crispWebSiteID = self.env.appConfig.getValue("CRISP_WEBSITE_ID")
      let uri: string
      if (crispWebSiteID) {
        const { profile } = self.authCore
        uri = `https://go.crisp.chat/chat/embed/?website_id=${crispWebSiteID}`
        if (self.currentUser?.email) {
          uri += `&email=${encodeURIComponent(self.currentUser.email)}`
        }
        if (profile?.primaryPhone) {
          uri += `&phone=${encodeURIComponent(profile.primaryPhone)}`
        }
      } else {
        uri = "https://help.like.co"
      }
      return uri
    },
    get hasPromptedAppRating() {
      return self.appRatingPromptedVersions.indexOf(self.getConfig("APP_RATING_VERSION")) !== -1
    },
  }))
  .views(self => ({
    get shouldPromptAppRating() {
      return !self.hasPromptedAppRating && Date.now() >= self.appRatingCooldown
    },
  }))
  .actions(self => ({
    setIsSigningIn(value: boolean) {
      self.isSigningIn = value
    },
    didPromptAppRating() {
      if (!self.hasPromptedAppRating) {
        self.appRatingPromptedVersions.push(self.getConfig("APP_RATING_VERSION"))
      }
      self.appRatingCooldown = 0
    },
    startAppRatingCooldown() {
      self.appRatingCooldown =
        Date.now() +
        (parseInt(self.getConfig("APP_RATING_COOLDOWN"), 10) || 5) *
        60000
    },
    register: flow(function * (params: UserRegisterParams) {
      const result: GeneralResult = yield self.env.likeCoAPI.register(params)
      switch (result.kind) {
        case "ok":
          break
        case "bad-data":
          switch (result.data) {
            case "EMAIL_ALREADY_USED":
              throw new Error("REGISTRATION_EMAIL_ALREADY_USED")
            case "USER_ALREADY_EXIST":
              throw new Error("REGISTRATION_LIKER_ID_ALREADY_USED")
            default:
              throw new Error("REGISTRATION_BAD_DATA")
          }
        default:
          throwProblem(result)
      }
    }),
    login: flow(function * (params: UserLoginParams) {
      const result: GeneralResult = yield self.env.likeCoAPI.login(params)
      switch (result.kind) {
        case "ok":
          break
        case "not-found":
          throw new Error("USER_NOT_FOUND")
        default:
          throwProblem(result)
      }
    }),
    logout: flow(function * () {
      self.isSigningOut = true
      self.currentUser = undefined
      try {
        self.iapStore.clear()
        yield Promise.all([
          self.env.likeCoAPI.logout(),
          self.authCore.signOut(),
        ])
        yield logoutAnalyticsUser()
      } finally {
        self.isSigningOut = false
      }
    }),
  }))
  .actions(self => ({
    fetchUserInfo: flow(function * () {
      const result: UserResult = yield self.env.likeCoAPI.fetchCurrentUserInfo()
      switch (result.kind) {
        case "ok": {
          const {
            user: likerID,
            displayName,
            email,
            avatar: avatarURL,
            isSubscribedCivicLiker: isCivicLiker,
          } = result.data
          self.currentUser = UserModel.create({
            likerID,
            displayName,
            email,
            avatarURL,
            isCivicLiker,
          })
          const userPIISalt = self.env.appConfig.getValue("USER_PII_SALT")
          const cosmosWallet = self.authCore.primaryCosmosAddress
          const authCoreUserId = self.authCore.profile.id
          const primaryPhone = self.authCore.profile.primaryPhone
          /* do not block user logic with analytics */
          updateAnalyticsUser({
            likerID,
            displayName,
            email,
            primaryPhone,
            oAuthFactors: self.env.authCoreAPI.getOAuthFactors(),
            cosmosWallet,
            authCoreUserId,
            userPIISalt,
          })
          break
        }
        case "unauthorized": {
          yield self.logout()
        }
      }
    }),
    fetchLikerLandUserInfo: flow(function * () {
      const result: UserResult = yield self.env.likerLandAPI.fetchCurrentUserInfo()
      switch (result.kind) {
        case "ok": {
          // Refresh session only, no user update for now
          break
        }
        case "unauthorized": {
          yield self.logout()
        }
      }
    }),
    rateApp: flow(function * () {
      try {
        yield new Promise((resolve, reject) => {
          Rate.rate({
            AppleAppID: "1248232355",
            GooglePackageName: "com.oice",
            preferredAndroidMarket: AndroidMarket.Google,
            preferInApp: true,
            openAppStoreIfInAppFails: true,
          }, (success) => {
            if (success) {
              // This technically only tells us if the user successfully went to the Review Page.
              // Whether they actually did anything, we do not know.
              self.didPromptAppRating()
              resolve()
            } else {
              reject(new Error("APP_RATE_ERROR"))
            }
          })
        })
      } catch (error) {
        logError(error)
      }
    }),
  }))

type UserStoreType = Instance<typeof UserStoreModel>
export interface UserStore extends UserStoreType {}
type UserStoreSnapshotType = SnapshotOut<typeof UserStoreModel>
export interface UserStoreSnapshot extends UserStoreSnapshotType {}
