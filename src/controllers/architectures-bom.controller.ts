import {Inject} from 'typescript-ioc';
import {
  Count,
  CountSchema,
  Filter,
  repository,
  Where,
} from '@loopback/repository';
import {inject} from "@loopback/core";
import {
  del,
  get,
  getModelSchemaRef,
  getWhereSchemaFor,
  param,
  patch,
  post,
  requestBody,
  Request,
  response,
  Response,
  oas,
  RestBindings
} from '@loopback/rest';
import {
  Architectures,
  Bom,
} from '../models';
import { ArchitecturesRepository, BomRepository, ControlMappingRepository, ServicesRepository } from '../repositories';
import { BomController } from '.';

import {
  ModuleSelector,
  CatalogLoader,
  Catalog
} from '@cloudnativetoolkit/iascable';

import {FILE_UPLOAD_SERVICE} from '../keys';
import {FileUploadHandler} from '../types';
import yaml, { YAMLException } from 'js-yaml';

import { Document as PDFDocument, Image, cm, Font } from "pdfjs";
import Jimp from "jimp";
import fs from "fs";

const catalogUrl = "https://raw.githubusercontent.com/cloud-native-toolkit/garage-terraform-modules/gh-pages/index.yaml"

/* eslint-disable no-throw-literal */

interface File {
  mimetype: string,
  buffer: Buffer,
  size: number
}

const loadAndValidateBomYaml = (yamlString:string) => {
  const doc = yaml.load(yamlString);
  if (doc.kind !== "BillOfMaterial")  throw new YAMLException("YAML property 'kind' must be set to 'BillOfMaterial'.");
  if (!doc.metadata.name) throw new YAMLException("YAML property 'metadata.name' must be set.");
  if (!doc?.spec?.modules.length) throw new YAMLException("YAML property 'spec.modules' must be a list of valid terraform modules.");
  return doc;
}

/* eslint-disable @typescript-eslint/naming-convention */

export class ArchitecturesBomController {

  @Inject
  moduleSelector!: ModuleSelector;
  @Inject
  loader!: CatalogLoader;
  catalog: Catalog;
  bomController: BomController;

  constructor(
    @repository(ArchitecturesRepository) protected architecturesRepository: ArchitecturesRepository,
    @repository(BomRepository) protected bomRepository: BomRepository,
    @repository(ControlMappingRepository) protected cmRepository: ControlMappingRepository,
    @repository(ServicesRepository) protected servicesRepository: ServicesRepository,
    @inject(FILE_UPLOAD_SERVICE) private fileHandler: FileUploadHandler
  ) {
    if (!this.bomController) this.bomController = new BomController(this.bomRepository, this.servicesRepository, this.architecturesRepository, this.cmRepository);
  }

  @get('/architectures/{id}/boms', {
    responses: {
      '200': {
        description: 'Array of Architectures has many Bom',
        content: {
          'application/json': {
            schema: {type: 'array', items: getModelSchemaRef(Bom)},
          },
        },
      },
    },
  })
  async find(
    @param.path.string('id') id: string,
    @param.query.object('filter') filter?: Filter<Bom>,
  ): Promise<Bom[]> {
    return this.architecturesRepository.boms(id).find(filter);
  }

  @get('/architectures/{archid}/compliance-report')
  @response(200, {
    description: 'Download PDF compliance report based on the reference architecture BOM',
  })
  @oas.response.file()
  async downloadComplianceReport(
    @param.path.string('archid') archId: string,
    @param.query.string('profile') profileId: string,
    @inject(RestBindings.Http.RESPONSE) res: Response,
  ) {
    // Get data
    const arch = await this.architecturesRepository.findById(archId);
    const archBom = await this.bomController.compositeCatalogByArchId(archId);
    const services = [...new Set(archBom.map(bom => bom.service))];
    const serviceIds = [...new Set(archBom.map(bom => bom.service_id))];
    const mappings = await this.cmRepository.find({
      "where": {
        "service_id": {
          "inq": serviceIds
        },
        "scc_profile": profileId
      },
      "include": [
        "profile",
        "goals",
        "control"
      ]
    });
    const controls = [...new Set(mappings.map(mapping => mapping.control))];

    // Build PDF Document
    const doc = new PDFDocument({
      font: new Font(fs.readFileSync('./fonts/IBMPlexSans-Regular.ttf')),
      padding: 50,
      fontSize: 11
    });
    doc.footer().pageNumber(function(curr, total) { return curr + ' / ' + total }, { textAlign: 'center' })
    doc.text(`${arch.name}\n\n`, { textAlign: 'center', fontSize: 32 });
    if (arch.diagram_link_png && arch.diagram_folder) {
      const image = await (await Jimp.read(`./public/images/${arch.diagram_folder}/${arch.diagram_link_png}`));
      const buffer  = await image.getBufferAsync(Jimp.MIME_JPEG);
      doc.image(new Image(buffer), { width: 750, align: 'center' });
    }
    doc.pageBreak();
    const bomCell = doc.cell({ paddingBottom: 0.5*cm });
    bomCell.text(`Bill of Materials`, { fontSize: 24 });
    for await (const p of archBom) {
      bomCell.text(`- ${p.desc}: ${p.service.ibm_catalog_service ?? p.service.service_id}`);
    }
    const servicesCell = doc.cell({ paddingBottom: 0.5*cm });
    servicesCell.text(`Services`, { fontSize: 24 });
    for await (const service of services) {
      if (service) {
        const serviceCell = servicesCell.cell({ paddingBottom: 0.5*cm });
        const catalog = archBom.find(elt => elt.service.service_id === service.service_id)?.catalog;
        serviceCell.text(`${service.ibm_catalog_service ?? service.service_id}`, { fontSize: 20 });
        serviceCell.text(`Description`, { fontSize: 16 });
        serviceCell.text(`${catalog?.overview_ui?.en?.long_description ?? catalog?.overview_ui?.en?.description ?? service.desc}`);
        if (catalog?.provider?.name) serviceCell.text(`- Provider: ${catalog?.provider?.name}`);
        if (service.grouping) serviceCell.text(`- Group: ${service.grouping}`);
        if (service.deployment_method) serviceCell.text(`- Deployment Method: ${service.deployment_method}`);
        if (service.provision) serviceCell.text(`- Provision: ${service.provision}`);
        // const serviceMappings = mappings.filter(elt => elt.service_id === service.service_id);
        // if (serviceMappings.length) {
        //   md += `\n### Impacting controls\n`;
        //   md += `\n|**Control ID** |**SCC Goal** |**Goal Description** |\n`;
        //   md += `|:--- |:--- |:--- |\n`;
        //   for (const mp of serviceMappings) {
        //     for (const goal of mp?.goals) {
        //       if (mp.control_id && mp?.control?.id) md += `|[**${mp.control_id}**](#${((mp.control.name && (mp.control.id + " " + mp.control.name)) || mp.control.id).toLowerCase().replace(/ /gi, '-').replace(/[()/&]/gi, '')}) |[${goal.goal_id}](https://cloud.ibm.com/security-compliance/goals/${goal.goal_id}) |${goal.description} |\n`;
        //       else if(mp.control_id) md += `|**${mp.control_id}** |[${goal.goal_id}](https://cloud.ibm.com/security-compliance/goals/${goal.goal_id}) |${goal.description} |\n`;
        //     }
        //   }
        // }
      }
    }
    const controlsCell = doc.cell({ paddingBottom: 0.5*cm });
    controlsCell.text(`Controls`, { fontSize: 24 });
    for await (const control of controls) {
      if (control) {
        const controlCell = controlsCell.cell({ paddingBottom: 0.5*cm });
        controlCell.text(`${(control.name && (control.id + " " + control.name)) || control.id}`, { fontSize: 20 });
        controlCell.text(`Description`, { fontSize: 16 });
        controlCell.text(`${control.description
          .replace(/\n\*\*([a-zA-Z1-9\(\)]+)\*\*/gi, '\n$1')
          .replace(/\n\n/gi, '\n')
          .replace(/\*\*Note\*\*/gi, 'Note')
          .replace(/\*\*Note:\*\*/gi, 'Note:')}`);
        if (control.parent_control) controlCell.text(`- Parent control: ${control.parent_control}`);
        controlCell.text(`Parameters`, { fontSize: 16 });
        controlCell.text(`${control.parameters.replace(/\*/gi, '')}`);
        controlCell.text(`Solution and Implementation`, { fontSize: 16 });
        controlCell.text(`${control.implementation
          .replace(/\n\*\*([a-zA-Z1-9\(\)]+)\*\*/gi, '\n$1')
          .replace(/\n\n/gi, '\n').replace(/\n\n/gi, '\n').replace(/\n\n/gi, '\n')
          .replace(/##### *([^\n]+)/gi, '\n$1\n')
          .replace(/#### *([^\n]+)/gi, '\n$1')
          .replace(/\*\*Note\*\*/gi, 'Note')
          .replace(/\*\*Note:\*\*/gi, 'Note:')}`)
      }
    }

    // Send PDF Document
    return doc.asBuffer();
  }

  @post('/architectures/{id}/boms', {
    responses: {
      '200': {
        description: 'Architectures model instance',
        content: {'application/json': {schema: getModelSchemaRef(Bom)}},
      },
    },
  })
  async create(
    @param.path.string('id') id: typeof Architectures.prototype.arch_id,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Bom, {
            title: 'NewBomInArchitectures',
            exclude: ['_id'],
            optional: ['arch_id']
          }),
        },
      },
    }) bom: Omit<Bom, '_id'>,
    @inject(RestBindings.Http.RESPONSE) res: Response,
  ): Promise<Bom|Response> {
    if (bom.automation_variables) {
      if (!this.catalog) {
        this.catalog = await this.loader.loadCatalog(catalogUrl);
      }
      // Validate automation_variables yaml
      const service = await this.servicesRepository.findById(bom.service_id);
      try {
        if(!service.cloud_automation_id) throw { message: `Service ${service.ibm_catalog_service} is missing automation ID .` };
        await this.moduleSelector.validateBillOfMaterialModuleConfigYaml(this.catalog, service.cloud_automation_id, bom.automation_variables);
      } catch (error) {
        console.log(error);
        return res.status(400).send({error: {
          message: `YAML automation variables config error.`,
          details: error
        }});
      }
    }
    return this.architecturesRepository.boms(id).create(bom);
  }

  @post('/architectures/boms/import', {
    responses: {
      200: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
            },
          },
        },
        description: 'Information about the import status',
      },
    },
  })
  async uploadBomYaml(
    @requestBody.file()
    request: Request,
    @inject(RestBindings.Http.RESPONSE) res: Response,
    @param.query.string('overwrite') overwrite: string
  ): Promise<object> {
    // Load Catalog
    if (!this.catalog) {
      this.catalog = await this.loader.loadCatalog(catalogUrl);
    }
    return new Promise<object>((resolve, reject) => {
      this.fileHandler(request, res,(err: unknown) => {
        let successCount = 0;
        (async () => {
          if (err) {
            throw err;
          } else {

            const uploadedFiles = request.files;
            const mapper = (f: globalThis.Express.Multer.File) => ({
              mimetype: f.mimetype,
              buffer: f.buffer,
              size: f.size
            });
            let files: File[] = [];
            if (Array.isArray(uploadedFiles)) {
              files = uploadedFiles.map(mapper);
            } else {
              for (const filename in uploadedFiles) {
                files.push(...uploadedFiles[filename].map(mapper));
              }
            }
            // Check uploaded files
            for (const file of files) {
              if (file.mimetype !== "application/x-yaml" && file.mimetype !== "text/yaml") throw {message: "You must only upload YAML files."};
              if (file.size > 102400) throw {message: "Files must me <= 100Ko."};
            }
            for (const file of files) {
              const doc = loadAndValidateBomYaml(file.buffer.toString());
              // Try to get corresponding architecture
              let arch: Architectures;
              let archExists = false;
              try {
                arch = await this.architecturesRepository.findById(doc.metadata.name);
                archExists = true;
              } catch (getArchError) {
                // Arch does not exist, create new
                arch = await this.architecturesRepository.create(new Architectures({
                  arch_id: doc.metadata.name,
                  name: doc.metadata.name,
                  short_desc: `${doc.metadata.name} Architecture.`,
                  long_desc: `${doc.metadata.name} FS Architecture.`,
                  diagram_folder: "placeholder",
                  diagram_link_drawio: "none",
                  diagram_link_png: "placeholder.png",
                  confidential: true
                }));
              }
              // Do not delete the architecture document accept it and love it and just update the variable
              if (archExists && !overwrite) throw { message: `Architecture ${doc.metadata.name} already exists. Set 'overwrite' parameter to overwrite.` };
              // Delete existing BOMs
              await this.architecturesRepository.boms(arch.arch_id).delete();
              // Set architecture automation variables
              await this.architecturesRepository.updateById(arch.arch_id, {
                automation_variables: yaml.dump({variables: doc.spec.variables})
              });
              // Import automation modules
              for (const module of doc.spec.modules) {
                // Validate module
                try {
                  await this.moduleSelector.validateBillOfMaterialModuleConfigYaml(this.catalog, module.name, yaml.dump(module));
                } catch (error) {
                  throw {
                    message: `YAML module config error for module ${module.name}`,
                    architecture: arch.arch_id,
                    details: error
                  }
                }
                const services = await this.servicesRepository.find({ where: { cloud_automation_id: module.name } });
                if (!services.length) throw {message: `No service matching automation ID ${module.name}`};
                const newBom = new Bom({
                  arch_id: arch.arch_id,
                  service_id: services[0].service_id,
                  desc: module.alias || module.name
                });
                if (module.alias && module.variables && module.dependencies) {
                  newBom.automation_variables = yaml.dump({alias: module.alias, variables: module.variables, dependencies: module.dependencies});
                } else if (module.alias && module.variables) {
                  newBom.automation_variables = yaml.dump({alias: module.alias, variables: module.variables});
                } else if (module.alias && module.dependencies) {
                  newBom.automation_variables = yaml.dump({alias: module.alias, dependencies: module.dependencies});
                } else if (module.alias) {
                  newBom.automation_variables = yaml.dump({alias: module.alias});
                } else if (module.variables) {
                  newBom.automation_variables = yaml.dump({variables: module.variables});
                }
                await this.architecturesRepository.boms(arch.arch_id).create(newBom);
              }
              successCount += 1;
            }
          }
        })()
        .then(() => resolve(res.status(200).send({ count: successCount })))
        .catch((error) => {
          reject(res.status(400).send({error: error}))
        });
      });
    });
  }

  @patch('/architectures/{id}/boms', {
    responses: {
      '200': {
        description: 'Architectures.Bom PATCH success count',
        content: {'application/json': {schema: CountSchema}},
      },
    },
  })
  async patch(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Bom, {partial: true}),
        },
      },
    })
    bom: Partial<Bom>,
    @param.query.object('where', getWhereSchemaFor(Bom)) where?: Where<Bom>,
  ): Promise<Count> {
    return this.architecturesRepository.boms(id).patch(bom, where);
  }

  @del('/architectures/{id}/boms', {
    responses: {
      '200': {
        description: 'Architectures.Bom DELETE success count',
        content: {'application/json': {schema: CountSchema}},
      },
    },
  })
  async delete(
    @param.path.string('id') id: string,
    @param.query.object('where', getWhereSchemaFor(Bom)) where?: Where<Bom>,
  ): Promise<Count> {
    return this.architecturesRepository.boms(id).delete(where);
  }
}
