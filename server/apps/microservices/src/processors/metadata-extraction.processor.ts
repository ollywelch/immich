import { AssetEntity, AssetType, ExifEntity } from '@app/infra';
import { IReverseGeocodingJob, IAssetUploadedJob, QueueName, JobName, IAssetRepository } from '@app/domain';
import { Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import sharp from 'sharp';
import { Repository } from 'typeorm/repository/Repository';
import geocoder, { InitOptions } from 'local-reverse-geocoder';
import { getName } from 'i18n-iso-countries';
import fs from 'node:fs';
import { ExifDateTime, exiftool, Tags } from 'exiftool-vendored';

interface ImmichTags extends Tags {
  ContentIdentifier?: string;
}

function geocoderInit(init: InitOptions) {
  return new Promise<void>(function (resolve) {
    geocoder.init(init, () => {
      resolve();
    });
  });
}

function geocoderLookup(points: { latitude: number; longitude: number }[]) {
  return new Promise<GeoData>(function (resolve) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    geocoder.lookUp(points, 1, (err, addresses) => {
      resolve(addresses[0][0] as GeoData);
    });
  });
}

const geocodingPrecisionLevels = ['cities15000', 'cities5000', 'cities1000', 'cities500'];

export type AdminCode = {
  name: string;
  asciiName: string;
  geoNameId: string;
};

export type GeoData = {
  geoNameId: string;
  name: string;
  asciiName: string;
  alternateNames: string;
  latitude: string;
  longitude: string;
  featureClass: string;
  featureCode: string;
  countryCode: string;
  cc2?: any;
  admin1Code?: AdminCode | string;
  admin2Code?: AdminCode | string;
  admin3Code?: any;
  admin4Code?: any;
  population: string;
  elevation: string;
  dem: string;
  timezone: string;
  modificationDate: string;
  distance: number;
};

@Processor(QueueName.METADATA_EXTRACTION)
export class MetadataExtractionProcessor {
  private logger = new Logger(MetadataExtractionProcessor.name);
  private isGeocodeInitialized = false;
  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @InjectRepository(ExifEntity)
    private exifRepository: Repository<ExifEntity>,

    configService: ConfigService,
  ) {
    if (!configService.get('DISABLE_REVERSE_GEOCODING')) {
      this.logger.log('Initializing Reverse Geocoding');
      geocoderInit({
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        citiesFileOverride: geocodingPrecisionLevels[configService.get('REVERSE_GEOCODING_PRECISION')],
        load: {
          admin1: true,
          admin2: true,
          admin3And4: false,
          alternateNames: false,
        },
        countries: [],
        dumpDirectory:
          configService.get('REVERSE_GEOCODING_DUMP_DIRECTORY') || process.cwd() + '/.reverse-geocoding-dump/',
      }).then(() => {
        this.isGeocodeInitialized = true;
        this.logger.log('Reverse Geocoding Initialised');
      });
    }
  }

  private async reverseGeocodeExif(
    latitude: number,
    longitude: number,
  ): Promise<{ country: string; state: string; city: string }> {
    const geoCodeInfo = await geocoderLookup([{ latitude, longitude }]);

    const country = getName(geoCodeInfo.countryCode, 'en');
    const city = geoCodeInfo.name;

    let state = '';

    if (geoCodeInfo.admin2Code) {
      const adminCode2 = geoCodeInfo.admin2Code as AdminCode;
      state += adminCode2.name;
    }

    if (geoCodeInfo.admin1Code) {
      const adminCode1 = geoCodeInfo.admin1Code as AdminCode;

      if (geoCodeInfo.admin2Code) {
        const adminCode2 = geoCodeInfo.admin2Code as AdminCode;
        if (adminCode2.name) {
          state += ', ';
        }
      }
      state += adminCode1.name;
    }

    return { country, state, city };
  }

  @Process(JobName.EXIF_EXTRACTION)
  async extractExifInfo(job: Job<IAssetUploadedJob>) {
    try {
      const { asset, fileName }: { asset: AssetEntity; fileName: string } = job.data;
      const exifData = await exiftool.read<ImmichTags>(asset.originalPath).catch((e) => {
        this.logger.warn(`The exifData parsing failed due to: ${e} on file ${asset.originalPath}`);
        return null;
      });

      const exifToDate = (exifDate: string | ExifDateTime | undefined) => {
        if (!exifDate) return null;

        if (typeof exifDate === 'string') {
          return new Date(exifDate);
        }

        return exifDate.toDate();
      };

      const fileCreatedAt = exifToDate(exifData?.DateTimeOriginal ?? exifData?.CreateDate ?? asset.fileCreatedAt);
      const fileModifiedAt = exifToDate(exifData?.ModifyDate ?? asset.fileModifiedAt);
      const fileStats = fs.statSync(asset.originalPath);
      const fileSizeInBytes = fileStats.size;

      const newExif = new ExifEntity();
      newExif.assetId = asset.id;
      newExif.imageName = path.parse(fileName).name;
      newExif.fileSizeInByte = fileSizeInBytes;
      newExif.make = exifData?.Make || null;
      newExif.model = exifData?.Model || null;
      newExif.exifImageHeight = exifData?.ExifImageHeight || exifData?.ImageHeight || null;
      newExif.exifImageWidth = exifData?.ExifImageWidth || exifData?.ImageWidth || null;
      newExif.exposureTime = exifData?.ExposureTime || null;
      newExif.orientation = exifData?.Orientation?.toString() || null;
      newExif.dateTimeOriginal = fileCreatedAt;
      newExif.modifyDate = fileModifiedAt;
      newExif.lensModel = exifData?.LensModel || null;
      newExif.fNumber = exifData?.FNumber || null;
      newExif.focalLength = exifData?.FocalLength ? parseFloat(exifData.FocalLength) : null;
      newExif.iso = exifData?.ISO || null;
      newExif.latitude = exifData?.GPSLatitude || null;
      newExif.longitude = exifData?.GPSLongitude || null;
      newExif.livePhotoCID = exifData?.MediaGroupUUID || null;

      await this.assetRepository.save({
        id: asset.id,
        fileCreatedAt: fileCreatedAt?.toISOString(),
      });

      if (newExif.livePhotoCID && !asset.livePhotoVideoId) {
        const motionAsset = await this.assetRepository.findLivePhotoMatch(
          newExif.livePhotoCID,
          asset.id,
          AssetType.VIDEO,
        );
        if (motionAsset) {
          await this.assetRepository.save({ id: asset.id, livePhotoVideoId: motionAsset.id });
          await this.assetRepository.save({ id: motionAsset.id, isVisible: false });
        }
      }

      /**
       * Reverse Geocoding
       *
       * Get the city, state or region name of the asset
       * based on lat/lon GPS coordinates.
       */
      if (this.isGeocodeInitialized && newExif.latitude && newExif.longitude) {
        const { country, state, city } = await this.reverseGeocodeExif(newExif.latitude, newExif.longitude);
        newExif.country = country;
        newExif.state = state;
        newExif.city = city;
      }

      /**
       * IF the EXIF doesn't contain the width and height of the image,
       * We will use Sharpjs to get the information.
       */
      if (!newExif.exifImageHeight || !newExif.exifImageWidth || !newExif.orientation) {
        const metadata = await sharp(asset.originalPath).metadata();

        if (newExif.exifImageHeight === null) {
          newExif.exifImageHeight = metadata.height || null;
        }

        if (newExif.exifImageWidth === null) {
          newExif.exifImageWidth = metadata.width || null;
        }

        if (newExif.orientation === null) {
          newExif.orientation = metadata.orientation !== undefined ? `${metadata.orientation}` : null;
        }
      }

      await this.exifRepository.upsert(newExif, { conflictPaths: ['assetId'] });
    } catch (error: any) {
      this.logger.error(`Error extracting EXIF ${error}`, error?.stack);
    }
  }

  @Process({ name: JobName.REVERSE_GEOCODING })
  async reverseGeocoding(job: Job<IReverseGeocodingJob>) {
    if (this.isGeocodeInitialized) {
      const { latitude, longitude } = job.data;
      const { country, state, city } = await this.reverseGeocodeExif(latitude, longitude);
      await this.exifRepository.update({ assetId: job.data.assetId }, { city, state, country });
    }
  }

  @Process({ name: JobName.EXTRACT_VIDEO_METADATA, concurrency: 2 })
  async extractVideoMetadata(job: Job<IAssetUploadedJob>) {
    const { asset, fileName } = job.data;

    if (!asset.isVisible) {
      return;
    }

    try {
      const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) =>
        ffmpeg.ffprobe(asset.originalPath, (err, data) => {
          if (err) return reject(err);
          return resolve(data);
        }),
      );
      let durationString = asset.duration;
      let fileCreatedAt = asset.fileCreatedAt;

      if (data.format.duration) {
        durationString = this.extractDuration(data.format.duration);
      }

      const videoTags = data.format.tags;
      if (videoTags) {
        if (videoTags['com.apple.quicktime.creationdate']) {
          fileCreatedAt = String(videoTags['com.apple.quicktime.creationdate']);
        } else if (videoTags['creation_time']) {
          fileCreatedAt = String(videoTags['creation_time']);
        }
      }

      const exifData = await exiftool.read<ImmichTags>(asset.originalPath).catch((e) => {
        this.logger.warn(`The exifData parsing failed due to: ${e} on file ${asset.originalPath}`);
        return null;
      });

      const newExif = new ExifEntity();
      newExif.assetId = asset.id;
      newExif.description = '';
      newExif.imageName = path.parse(fileName).name || null;
      newExif.fileSizeInByte = data.format.size || null;
      newExif.dateTimeOriginal = fileCreatedAt ? new Date(fileCreatedAt) : null;
      newExif.modifyDate = null;
      newExif.latitude = null;
      newExif.longitude = null;
      newExif.city = null;
      newExif.state = null;
      newExif.country = null;
      newExif.fps = null;
      newExif.livePhotoCID = exifData?.ContentIdentifier || null;

      if (newExif.livePhotoCID) {
        const photoAsset = await this.assetRepository.findLivePhotoMatch(
          newExif.livePhotoCID,
          asset.id,
          AssetType.IMAGE,
        );
        if (photoAsset) {
          await this.assetRepository.save({ id: photoAsset.id, livePhotoVideoId: asset.id });
          await this.assetRepository.save({ id: asset.id, isVisible: false });
        }
      }

      if (videoTags && videoTags['location']) {
        const location = videoTags['location'] as string;
        const locationRegex = /([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)\/$/;
        const match = location.match(locationRegex);

        if (match?.length === 3) {
          newExif.latitude = parseFloat(match[1]);
          newExif.longitude = parseFloat(match[2]);
        }
      } else if (videoTags && videoTags['com.apple.quicktime.location.ISO6709']) {
        const location = videoTags['com.apple.quicktime.location.ISO6709'] as string;
        const locationRegex = /([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)\/$/;
        const match = location.match(locationRegex);

        if (match?.length === 4) {
          newExif.latitude = parseFloat(match[1]);
          newExif.longitude = parseFloat(match[2]);
        }
      }

      // Reverse GeoCoding
      if (this.isGeocodeInitialized && newExif.longitude && newExif.latitude) {
        const { country, state, city } = await this.reverseGeocodeExif(newExif.latitude, newExif.longitude);
        newExif.country = country;
        newExif.state = state;
        newExif.city = city;
      }

      for (const stream of data.streams) {
        if (stream.codec_type === 'video') {
          newExif.exifImageWidth = stream.width || null;
          newExif.exifImageHeight = stream.height || null;

          if (typeof stream.rotation === 'string') {
            newExif.orientation = stream.rotation;
          } else if (typeof stream.rotation === 'number') {
            newExif.orientation = `${stream.rotation}`;
          } else {
            newExif.orientation = null;
          }

          if (stream.r_frame_rate) {
            const fpsParts = stream.r_frame_rate.split('/');

            if (fpsParts.length === 2) {
              newExif.fps = Math.round(parseInt(fpsParts[0]) / parseInt(fpsParts[1]));
            }
          }
        }
      }

      await this.exifRepository.upsert(newExif, { conflictPaths: ['assetId'] });
      await this.assetRepository.save({ id: asset.id, duration: durationString, fileCreatedAt });
    } catch (err) {
      ``;
      // do nothing
      console.log('Error in video metadata extraction', err);
    }
  }

  private extractDuration(duration: number) {
    const videoDurationInSecond = parseInt(duration.toString(), 0);

    const hours = Math.floor(videoDurationInSecond / 3600);
    const minutes = Math.floor((videoDurationInSecond - hours * 3600) / 60);
    const seconds = videoDurationInSecond - hours * 3600 - minutes * 60;

    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.000000`;
  }
}
