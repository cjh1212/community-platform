import { observable, action, computed, toJS, makeObservable } from 'mobx'
import { Subscription } from 'rxjs'
import Fuse from 'fuse.js'
import {
  IHowto,
  IHowtoFormInput,
  IHowToStepFormInput,
  IHowtoStep,
  IHowtoDB,
  IHowtoStats,
} from 'src/models/howto.models'
import { IConvertedFileMeta } from 'src/components/ImageInput/ImageInput'
import { IUploadedFileMeta } from '../storage'
import { ModuleStore } from '../common/module.store'
import { ISelectedTags } from 'src/models/tags.model'
import { RootStore } from '..'
import { IUser } from 'src/models/user.models'
import { hasAdminRights, needsModeration } from 'src/utils/helpers'

const COLLECTION_NAME = 'howtos'
const HOWTO_SEARCH_WEIGHTS = [
  { name: 'title', weight: 0.5 },
  { name: 'description', weight: 0.2 },
  { name: '_createdBy', weight: 0.15 },
  { name: 'steps.title', weight: 0.1 },
  { name: 'steps.text', weight: 0.05 },
]

export class HowtoStore extends ModuleStore {
  // we have two property relating to docs that can be observed
  @observable
  public activeHowto: IHowtoDB | undefined
  @observable
  public allHowtos: IHowtoDB[]
  @observable
  public selectedTags: ISelectedTags
  @observable
  public searchValue: string
  @observable
  public uploadStatus: IHowToUploadStatus = getInitialUploadStatus()
  @observable howtoStats: IHowtoStats | undefined
  private howtoStats$: Subscription
  constructor(rootStore: RootStore) {
    // call constructor on common ModuleStore (with db endpoint), which automatically fetches all docs at
    // the given endpoint and emits changes as data is retrieved from cache and live collection
    super(rootStore, COLLECTION_NAME)
    makeObservable(this)
    this.allDocs$.subscribe((docs: IHowtoDB[]) => {
      this.allHowtos = docs.sort((a, b) => (a._created < b._created ? 1 : -1))
    })
    this.selectedTags = {}
  }

  @action
  public async setActiveHowtoBySlug(slug: string) {
    const collection = await this.db
      .collection<IHowto>(COLLECTION_NAME)
      .getWhere('slug', '==', slug)
    const activeHowto = collection.length > 0 ? collection[0] : undefined
    this.activeHowto = activeHowto
    // load howto stats which are stored in a separate subcollection
    this.loadHowtoStats(activeHowto?._id)

    return activeHowto
  }
  @action
  public async loadHowtoStats(id?: string) {
    this.howtoStats = undefined
    if (id) {
      const ref = this.db
        .collection<IHowtoStats>('howtos')
        .doc(`${id}/stats/all`)
      if (this.howtoStats) {
        this.howtoStats$.unsubscribe()
      }
      this.howtoStats$ = ref.stream().subscribe(stats => {
        this.howtoStats = stats as any
      })
    }
  }
  @action
  public updateUploadStatus(update: keyof IHowToUploadStatus) {
    this.uploadStatus[update] = true
  }

  @action
  public resetUploadStatus() {
    this.uploadStatus = getInitialUploadStatus()
  }

  @computed get filteredHowtos() {
    const howtos = this.filterCollectionByTags(
      this.allHowtos,
      this.selectedTags,
    )
    // HACK - ARH - 2019/12/11 filter unaccepted howtos, should be done serverside
    const activeUser = this.activeUser
    const isAdmin = hasAdminRights(activeUser)
    const validHowtos = howtos.filter(howto => {
      const isHowToAccepted = howto.moderation === 'accepted'
      const wasCreatedByUser =
        activeUser && howto._createdBy === activeUser.userName
      const isAdminAndAccepted =
        isAdmin &&
        howto.moderation !== 'draft' &&
        howto.moderation !== 'rejected'

      return isHowToAccepted || wasCreatedByUser || isAdminAndAccepted
    })

    // If user searched, filter remaining howtos by the search query with Fuse
    if (!this.searchValue) {
      return validHowtos
    } else {
      const fuse = new Fuse(validHowtos, {
        keys: HOWTO_SEARCH_WEIGHTS,
      })

      // Currently Fuse returns objects containing the search items, hence the need to map. https://github.com/krisk/Fuse/issues/532
      return fuse.search(this.searchValue).map(v => v.item)
    }
  }

  public updateSearchValue(query: string) {
    this.searchValue = query
  }

  public updateSelectedTags(tagKey: ISelectedTags) {
    this.selectedTags = tagKey
  }

  // Moderate Howto
  public async moderateHowto(howto: IHowto) {
    if (!hasAdminRights(toJS(this.activeUser))) {
      return false
    }
    const doc = this.db.collection(COLLECTION_NAME).doc(howto._id)
    return doc.set(howto)
  }

  public needsModeration(howto: IHowto) {
    return needsModeration(howto, toJS(this.activeUser))
  }

  // upload a new or update an existing how-to
  public async uploadHowTo(values: IHowtoFormInput | IHowtoDB) {
    console.log('uploading howto')
    this.updateUploadStatus('Start')
    // create a reference either to the existing document (if editing) or a new document if creating
    const dbRef = this.db
      .collection<IHowto>(COLLECTION_NAME)
      .doc((values as IHowtoDB)._id)
    const id = dbRef.id
    const user = this.activeUser as IUser
    try {
      // upload any pending images, avoid trying to re-upload images previously saved
      // if cover already uploaded stored as object not array
      // file and step image re-uploads handled in uploadFile script
      let processedCover
      if (!values.cover_image.hasOwnProperty('downloadUrl')) {
        processedCover = await this.uploadFileToCollection(
          values.cover_image,
          COLLECTION_NAME,
          id,
        )
      } else {
        processedCover = values.cover_image as IUploadedFileMeta
      }

      this.updateUploadStatus('Cover')
      const processedSteps = await this.processSteps(values.steps, id)
      this.updateUploadStatus('Step Images')
      // upload files
      const processedFiles = await this.uploadCollectionBatch(
        values.files as File[],
        COLLECTION_NAME,
        id,
      )
      this.updateUploadStatus('Files')
      // populate DB
      // redefine howTo based on processing done above (should match stronger typing)
      const howTo: IHowto = {
        ...values,
        _createdBy: values._createdBy ? values._createdBy : user.userName,
        cover_image: processedCover,
        steps: processedSteps,
        files: processedFiles,
        moderation: values.moderation
          ? values.moderation
          : 'awaiting-moderation',
        // Avoid replacing user flag on admin edit
        creatorCountry:
          (values._createdBy && values._createdBy === user.userName) ||
          !values._createdBy
            ? user.location
              ? user.location.countryCode
              : user.country
              ? user.country.toLowerCase()
              : ''
            : values.creatorCountry
            ? values.creatorCountry
            : '',
      }
      console.log('populating database', howTo)
      // set the database document
      await dbRef.set(howTo)
      this.updateUploadStatus('Database')
      console.log('post added')
      this.activeHowto = await dbRef.get()
      // complete
      this.updateUploadStatus('Complete')
    } catch (error) {
      console.log('error', error)
      throw new Error(error.message)
    }
  }

  // go through each step, upload images and replace data
  private async processSteps(steps: IHowToStepFormInput[], id: string) {
    // NOTE - outer loop could be a map and done in parallel but for loop easier to manage
    const stepsWithImgMeta: IHowtoStep[] = []
    for (const step of steps) {
      // determine any new images to upload
      const stepImages = (step.images as IConvertedFileMeta[]).filter(
        img => !!img,
      )
      const imgMeta = await this.uploadCollectionBatch(
        stepImages,
        COLLECTION_NAME,
        id,
      )
      step.images = imgMeta
      stepsWithImgMeta.push({
        ...step,
        images: imgMeta.map(f => {
          if (f === undefined) {
            return null
          }

          return f
        }),
      })
    }
    return stepsWithImgMeta
  }

  get isActiveHowToUseful(): boolean {
    const howtoId = this.activeHowto!._id
    const userVotedHowtos = this.activeUser?.votedUsefulHowtos || {}
    return userVotedHowtos[howtoId]
  }
}

interface IHowToUploadStatus {
  Start: boolean
  Cover: boolean
  Files: boolean
  'Step Images': boolean
  Database: boolean
  Complete: boolean
}

function getInitialUploadStatus() {
  const status: IHowToUploadStatus = {
    Start: false,
    Cover: false,
    'Step Images': false,
    Files: false,
    Database: false,
    Complete: false,
  }
  return status
}
